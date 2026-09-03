// ---------------------------------------------------------------------------
// src/contracts -- the frozen seam
// ---------------------------------------------------------------------------
//
// Three interfaces live here and nowhere else: the tool inputs, the tool response,
// and the SSE events. Every package in the workspace depends on this one; this one
// depends on nothing but zod.
//
// **Tracks do not edit this package.** A track that needs a change writes it in
// `docs/track-notes/<track>.md` and stops. A track that edits it unilaterally has
// silently forked the interface, which is the one failure the parallel split cannot
// recover from by merging harder.

export * from "./errors.js";
export * from "./events.js";
export * from "./filters.js";
export * from "./response.js";
export * from "./scalars.js";
export * from "./thresholds.js";
