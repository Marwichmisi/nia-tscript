// PROTOTYPE jetable — ticket wayfinder #5. Contrat screenshot agent (simulé).
// Capture le contenu visible (canvas WebGL/2D ou SVG) → PNG dataURL + taille + download.

export type ScreenshotKind = "schematique_2d" | "pcb_2d" | "pcb_3d"

export interface ScreenshotResult {
  kind: ScreenshotKind
  dataUrl: string
  bytes: number
  source: string // "canvas" | "svg→canvas"
  width: number
  height: number
}

function svgToPngDataUrl(svg: SVGSVGElement): Promise<{ dataUrl: string; w: number; h: number }> {
  const clone = svg.cloneNode(true) as SVGSVGElement
  const rect = svg.getBoundingClientRect()
  const w = Math.max(1, Math.round(rect.width))
  const h = Math.max(1, Math.round(rect.height))
  clone.setAttribute("width", String(w))
  clone.setAttribute("height", String(h))
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg")
  const xml = new XMLSerializer().serializeToString(clone)
  const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement("canvas")
      c.width = w
      c.height = h
      c.getContext("2d")!.drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(url)
      resolve({ dataUrl: c.toDataURL("image/png"), w, h })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("rasterisation SVG→PNG impossible"))
    }
    img.src = url
  })
}

export async function captureScreenshot(
  container: HTMLElement,
  kind: ScreenshotKind,
): Promise<ScreenshotResult> {
  // Préfère le premier canvas non vide (viewers 2D canvas / 3D WebGL).
  // NOTE prototype : sans preserveDrawingBuffer, un canvas WebGL peut sortir noir — c'est un point du verdict.
  const canvases = Array.from(container.querySelectorAll("canvas")).filter(
    (c) => c.width > 0 && c.height > 0,
  )
  for (const c of canvases) {
    try {
      const dataUrl = (c as HTMLCanvasElement).toDataURL("image/png")
      if (dataUrl.length > 1000) {
        return {
          kind,
          dataUrl,
          bytes: Math.round((dataUrl.length * 3) / 4),
          source: "canvas",
          width: (c as HTMLCanvasElement).width,
          height: (c as HTMLCanvasElement).height,
        }
      }
    } catch {
      /* canvas tainted (WebGL cross-origin) → essaie le SVG */
    }
  }
  const svg = Array.from(container.querySelectorAll("svg"))
    .map((s) => {
      const r = (s as SVGSVGElement).getBoundingClientRect()
      return { s: s as SVGSVGElement, area: r.width * r.height }
    })
    .filter((x) => x.area > 0)
    .sort((a, b) => b.area - a.area)[0]?.s
  if (svg) {
    const { dataUrl, w, h } = await svgToPngDataUrl(svg as SVGSVGElement)
    return {
      kind,
      dataUrl,
      bytes: Math.round((dataUrl.length * 3) / 4),
      source: "svg→canvas",
      width: w,
      height: h,
    }
  }
  throw new Error("aucun canvas ni SVG capturable dans cette vue")
}
