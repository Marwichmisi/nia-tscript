// Hôte sidecar T1 (#56) : réexporte le pur de tools-core/sourcing.ts et
// fournit le wrapper `searchParts` à `fetch` global par défaut (même
// signature externe qu'avant — le cœur exige `fetchFn` injecté).
import { searchParts as searchPartsCore } from "./tools-core/sourcing.js";
import type { FetchFn } from "./tools-core/sourcing.js";

export {
  JLCSEARCH_BASE,
  TSCI_SEARCH_DOC,
  TSCI_IMPORT_DOC,
  OFFLINE_SOURCING_BANNER,
  generateFootprintDsl,
  resolveFootprint,
  parseQueryHints,
  scorePart,
  type FootprintSource,
  type PartResult,
  type SearchPartsOk,
  type SearchPartsErr,
  type GenerateFootprintOk,
  type GenerateFootprintErr,
} from "./tools-core/sourcing.js";
export type { FetchFn };

export interface SearchPartsOptions {
  limit?: number;
  disableCdnLoading?: boolean;
  fetchFn?: FetchFn;
}

/** Wrapper hôte : injecte le `fetch` global quand l'appelant n'en fournit
 *  pas (tests existants, outil MCP). Le cœur reste sans réseau direct. */
export function searchParts(
  query: string,
  opts?: SearchPartsOptions,
): Promise<
  import("./tools-core/sourcing.js").SearchPartsOk | import("./tools-core/sourcing.js").SearchPartsErr
> {
  return searchPartsCore(query, {
    limit: opts?.limit,
    disableCdnLoading: opts?.disableCdnLoading,
    fetchFn: opts?.fetchFn ?? fetch,
  });
}
