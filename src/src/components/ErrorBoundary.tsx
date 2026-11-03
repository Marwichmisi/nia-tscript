import { Component, type ReactNode } from "react";

interface Props {
  tabName: string;
  /** Incrémenté à chaque nouveau circuit-json (ticket #45) : la frontière
   *  d'erreur repart saine au lieu de figer l'échec précédent. */
  resetKey: string;
  children: ReactNode;
}

interface State {
  error: string | null;
}

export class ViewerErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(e: unknown): State {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="viewer-fallback" role="alert">
          <div className="viewer-fallback-title">Rendu 3D/PCB indisponible ici</div>
          <p>
            Sans GPU, les viewers affichent «&nbsp;WebGPU rendering failed&nbsp;» (constaté au
            prototype). Fallback documenté&nbsp;: le screenshot agent bascule sur SVG/canvas 2D,
            jamais d&apos;image inventée.
          </p>
          <pre className="viewer-fallback-err">{this.state.error}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}
