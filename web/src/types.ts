// Message types between the main thread and the Pyodide Web Worker.

export type WorkerProgress = {
  stage: string;
  message: string;   // German fallback text (used if i18nKey is absent/unknown)
  pct: number;       // 0..1
  // Optional i18n key so the UI can translate the progress line live. Params
  // are substituted into the keyed template via t(); message stays the
  // German fallback for forward-compat.
  i18nKey?: string;
  i18nParams?: Record<string, string | number>;
};

export type WorkerRequest =
  | { id: number; kind: "init" }
  | {
      id: number;
      kind: "detect";
      ifc_bytes: ArrayBuffer;
      ifc_filename: string;
      target?: string | null;
      rules_bytes?: ArrayBuffer | null;
      // When true the worker defers the expensive L7 distance pass and the
      // caller follows up with a {kind:"distances"} request once the main
      // result is rendered. Omitted/false = compute everything inline.
      defer_distances?: boolean;
    }
  // Background L7 pass over the LAST detection (no IFC re-parse). The worker
  // replies with {kind:"distances"} carrying the table + re-evaluated rules.
  | { id: number; kind: "distances" }
  // On-demand IFC export of the LAST detection with user-chosen content
  // (Pset / classified submeshes / Pruefung). The worker re-emits the IFC
  // from cached state and replies with {kind:"export-ifc"} carrying the b64.
  | {
      id: number;
      kind: "export-ifc";
      options: { pset: boolean; submeshes: boolean; pruefung: boolean };
    };

export type DetectionMesh = {
  vertices: number[];
  faces: number[];
};

export type Cavity = DetectionMesh & {
  kind: string;
  element_name?: string;
  element_guid?: string;
};

export type ContextMesh = DetectionMesh & {
  ifc_type: string;
  name: string;
};

export type RuleCheck = {
  id: string;
  label: string;
  value: number | string;
  soll: string;
  status: "PASS" | "FAIL" | "WARN" | "INFO" | "SKIP";
  einheit?: string;
  target?: string;
  source?: string;
  severity?: string;
  // Klartext-Begründung (dt.) für INFO/WARN/SKIP — trägt den reason aus
  // evaluate() (z.B. context_reason). Als Tooltip am Status-Chip angezeigt.
  note?: string;
  context_check?: "ok" | "fail" | "unavailable" | string;
  context_reason?: string;
};

// A single confidence entry {score, level, basis} as emitted by
// confidence.py. `score` is 0..1 or null; `level` is the Ampel stage.
export type ConfidenceEntry = {
  score: number | null;
  level: "hoch" | "mittel" | "niedrig" | "unbekannt" | string;
  basis: string;
};

// The full confidence section attached to each wall_metrics entry
// (metrics.py -> "confidence"). Keys mirror confidence.compute_confidence().
export type WallConfidence = {
  classification?: ConfidenceEntry;
  crown_width?: ConfidenceEntry;
  thickness?: ConfidenceEntry;
  slope?: ConfidenceEntry;
  volume?: ConfidenceEntry;
  niches?: ConfidenceEntry;
  overall?: ConfidenceEntry;
  _signals?: Record<string, unknown>;
};

// L5 — internal context (stem <-> foundation), from context.internal_context().
export type InternalContext = {
  foundation_present?: boolean;
  source?: string;
  foundation_overhang_left_m?: number | null;
  foundation_overhang_right_m?: number | null;
  stem_centered_on_foundation?: boolean | null;
  shared_interface_area_m2?: number | null;
  foundation_to_stem_volume_ratio?: number | null;
};

// L6 — external context (air/earth side), from context.external_context().
export type ExternalContext = {
  air_side_face_class?: string | null;
  earth_side_face_class?: string | null;
  terrain_present?: boolean;
  terrain_median_distance_air_m?: number | null;
  terrain_median_distance_earth_m?: number | null;
  classification_source?: string;
  // Wie die Luft-/Erdseite bestimmt wurde: 'terrain_touch' (über Berührung) |
  // 'unbestimmt' (kein Terrain / nur eine Seite / kein Offset / Fehler).
  side_source?: string;
  // true = eindeutig (Erd-Seite berührt < 0.5·median_edge UND Luftseite ≥ 2×
  // Erd-Distanz); sonst nicht eindeutig.
  side_clear?: boolean;
  // L7-Einbindetiefe: UK unter Terrain, min/max über K3-Hauptflächen-Vertices.
  // POSITIV = Unterkante unter Terrain; null wenn nicht bestimmbar.
  uk_below_terrain_min_m?: number | null;
  uk_below_terrain_max_m?: number | null;
};

export type WallContext = {
  internal?: InternalContext;
  external?: ExternalContext;
  // L5 — geometrische Nachbarn über geteilte Fläche/Kante/Punkt
  // (adjacency.scene_adjacency; höchste Sharing-Stufe je Nachbar).
  neighbors?: Array<{
    other_guid?: string;
    other_name?: string;
    other_type?: string;
    level?: "face" | "edge" | "point" | string;
    shared_area_m2?: number | null;
    containment_self?: number | null;
  }>;
};

// L7 — pairwise distance record between two products (distances.scene_distances).
export type DistanceRecord = {
  from_guid?: string;
  from_name?: string;
  from_type?: string;
  to_guid?: string;
  to_name?: string;
  to_type?: string;
  min_distance_m?: number | null;
  horizontal_distance_m?: number | null;
  vertical_distance_m?: number | null;
  perpendicular_distance_m?: number | null;
  perpendicular_reason?: string | null;
  aabb_distance_m?: number | null;
  overlap_volume_m3?: number | null;
};

export type WallMetrics = {
  element_name?: string;
  element_guid?: string;
  element_guids?: string[];
  volume_m3?: number;
  surface_area_m2?: number;
  centroid?: [number, number, number];
  // PCA wall-frame axes (world-aligned Vt from metrics.py).
  // long = wall length axis, height = vertical, thickness = perpendicular.
  // Used by issues.ts to place dimension lines along the *true* wall axes
  // instead of guessing from AABB extents.
  wall_axes?: {
    long: [number, number, number];
    height: [number, number, number];
    thickness: [number, number, number];
  };
  dimensions?: {
    length?: number;
    height?: number;
    nominal_thickness?: number;
    // Lokale Ray-Cast-Höhe (m) — metrics.height_local().
    height_local?: { min?: number | null; max?: number | null; avg?: number | null; median?: number | null; n?: number };
    // Horizontale Bogenlängen je Kante (m) — metrics.developed_lengths().
    developed_length?: { front_top?: number | null; front_bottom?: number | null; back_top?: number | null; back_bottom?: number | null; min?: number | null; max?: number | null; avg?: number | null; method?: string };
  };
  thickness?: { min?: number; max?: number; avg?: number; median?: number; n_samples?: number };
  // Restwandstärke an der Nische (metrics.thickness_at_niche). The SPA
  // runtime key is `min_global` (NOT `restwandstaerke_niche`).
  thickness_at_niche?: {
    min_global?: number | null;
    per_niche?: Array<Record<string, unknown>>;
    unit?: string;
  };
  batter?: { front_deg?: number; front_ratio?: string; back_deg?: number; back_ratio?: string };
  // slope carries both the transverse (crown_deg/foundation_deg) and the
  // longitudinal (crown_longitudinal_*/foundation_longitudinal_*) gradients.
  slope?: {
    crown_deg?: number;
    foundation_deg?: number;
    crown_longitudinal_deg?: number | null;
    crown_longitudinal_percent?: number | null;
    crown_longitudinal_n_stations?: number;
    crown_longitudinal_reason?: string;
    foundation_longitudinal_deg?: number | null;
    foundation_longitudinal_percent?: number | null;
    foundation_longitudinal_n_stations?: number;
    foundation_longitudinal_reason?: string;
  };
  niches?: { count?: number; total_volume_m3?: number };
  area_per_class?: Record<string, number>;
  // L5/L6 internal + external context (ifcinspect attaches this).
  context?: WallContext;
  // Per-wall self-uncertainty scores (metrics.confidence section).
  confidence?: WallConfidence;
  error?: string;
  prep_failed?: boolean;
  prep_failure_reason?: string;
  pruefung?: RuleCheck[];
  [k: string]: unknown;
};

export type DetectionResult = {
  ok: true;
  wall_name: string;
  approximated: boolean;
  candidates: [string, string][];
  chosen_guid: string;
  method: string;
  timings: Record<string, number>;
  cavity_count: number;
  scene: {
    // `undefined`/array = computed; `null` = deferred L7 pass still running in
    // the background (main.ts patches it in when the worker replies).
    distances?: DistanceRecord[] | null;
    n_products?: number;
    // Szenenweite Erd-Seiten-Legende (ifcinspect._run_context_pass): nur
    // 'K4'/'K5' wenn ALLE eindeutigen Wände dieselbe Erdseite melden, sonst null.
    earth_side_class?: "K4" | "K5" | null;
    [k: string]: unknown;
  };
  wall_metrics: WallMetrics[];
  wall_mesh: DetectionMesh | null;
  cavities: Cavity[];
  context_meshes: ContextMesh[];
  ifc_bytes_b64?: string | null;
  glb_bytes_b64?: string | null;
};

export type WorkerResponse =
  | { id: number; kind: "ready" }
  | { id: number; kind: "progress"; progress: WorkerProgress }
  | { id: number; kind: "ok"; result: DetectionResult }
  | {
      id: number;
      kind: "distances";
      scene_distances: DistanceRecord[];
      wall_metrics: WallMetrics[];
    }
  | { id: number; kind: "export-ifc"; b64: string }
  | { id: number; kind: "error"; error: string };
