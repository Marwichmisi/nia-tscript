// PROTOTYPE jetable — ticket wayfinder #5.
// Stub navigateur de @resvg/resvg-js (binaire natif Node, non bundlable).
// Chemin d'usage upstream = branche `isNode` uniquement (svg→png côté serveur) ;
// le navigateur utilise canvas/Image. Le stub échoue proprement si appelé.
export class Resvg {
  constructor() {
    throw new Error("PROTOTYPE : Resvg natif non disponible dans le navigateur")
  }
  static version = "prototype-stub"
}
export default { Resvg }
