// Thin ESM re-export shim for the vendored `autoevals` package.
//
// Only the scorers the built-in evals consume are surfaced, so the vendor
// pipeline pulls a small, stable surface rather than the whole scorer set.
export { ClosedQA, Factuality, Levenshtein, Sql, Summary } from "autoevals";
