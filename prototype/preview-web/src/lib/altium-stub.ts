// PROTOTYPE jetable — ticket wayfinder #5.
// Stub du seul import dynamique de runframe non publié sur npm
// ("circuit-json-to-altium" = dépendance github:tscircuit/... du build runframe).
// L'export Altium n'est pas la question du ticket ; le stub échoue proprement
// si le bouton est cliqué.
export function convertCircuitJsonToAltiumZip(): Promise<never> {
  return Promise.reject(new Error("PROTOTYPE : export Altium non supporté (dep github-only stublée)"))
}
export default { convertCircuitJsonToAltiumZip }
