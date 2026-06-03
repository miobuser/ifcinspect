// web-ifc Geometrie-Loader für den Worker.
//
// web-ifc (C++/WASM) tesselliert JEDE IFC-Geometrie — tessellated, FacetedBrep,
// CSG/Extrusion — ohne OpenCASCADE und um Grössenordnungen schneller als der
// ifcopenshell-Iterator im Pyodide-Browser. Dieser Loader öffnet das Modell,
// streamt alle Meshes in Weltkoordinaten und gibt pro Produkt
// {guid, ifc_type, vertices, faces} zurück. Die Python-Pipeline verschweisst
// die (unverschweissten) Vertices dann via webifc_mesh.weld_mesh, sodass die
// K6-Nischenerkennung mit OpenCASCADE übereinstimmt.

import { IfcAPI, LogLevel } from "web-ifc";
import { DEBUG, dlog } from "./debug";

export type WebIfcProduct = {
  guid: string;
  ifc_type: string;
  vertices: Float64Array;
  faces: Uint32Array;
};

let api: IfcAPI | null = null;

async function ensureApi(): Promise<IfcAPI> {
  if (api) return api;
  dlog("[webifc] new IfcAPI, SetWasmPath('/'), Init(singleThread) …");
  const a = new IfcAPI();
  // web-ifc lädt sein WASM von `<wasmPath>/web-ifc.wasm`. Wir kopieren
  // web-ifc.wasm nach public/ (un-gehasht unter dem Site-Root), SetWasmPath("/")
  // trifft sie genau. KEIN fetch-Monkeypatch (würde Pyodides Fetches brechen).
  a.SetWasmPath("/", true);
  // forceSingleThread=true: die Seite ist crossOriginIsolated (COEP für Pyodide),
  // sonst würde web-ifc die multithreaded web-ifc-mt.wasm laden und einen
  // SharedArrayBuffer-Worker-Pool spawnen — das hängt in unserem bereits
  // verschachtelten Worker-Kontext. Single-thread nutzt die einfache
  // web-ifc.wasm (die wir in public/ haben) und läuft stabil.
  await a.Init(undefined, true);
  // web-ifc loggt eigenstaendig aus dem WASM in die Konsole (z.B.
  // "[WEB-IFC][error][TriangulateBounds()] No basis found for brep!" — nicht-fatale
  // Geometrie-Hinweise, die Pipeline ueberspringt solche Faces). In Prod aus, in Dev
  // nur Fehler. Mein Pyodide-stdout/stderr-Gate greift hier NICHT (eigene WASM).
  a.SetLogLevel(DEBUG ? LogLevel.LOG_LEVEL_ERROR : LogLevel.LOG_LEVEL_OFF);
  dlog("[webifc] Init() done");
  api = a;
  return a;
}

function applyMatrix(
  m: Float32Array | number[],
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** Lade alle Produkt-Meshes aus IFC-Bytes via web-ifc (Weltkoordinaten). */
export async function loadWebIfcMeshes(
  ifcBytes: Uint8Array,
): Promise<WebIfcProduct[]> {
  const a = await ensureApi();
  dlog("[webifc] OpenModel …");
  const modelID = a.OpenModel(ifcBytes);
  dlog("[webifc] OpenModel ok, id=", modelID, "→ StreamAllMeshes …");
  const out: WebIfcProduct[] = [];
  let meshCount = 0;
  try {
    a.StreamAllMeshes(modelID, (mesh) => {
      meshCount++;
      const eid = mesh.expressID;
      let guid = String(eid);
      let itype = "IfcProduct";
      try {
        const line = a.GetLine(modelID, eid) as {
          GlobalId?: { value?: string };
          type?: number;
        };
        if (line && line.GlobalId && line.GlobalId.value) guid = line.GlobalId.value;
        if (line && typeof line.type === "number") {
          const tn = (a as unknown as {
            GetNameFromTypeCode?: (t: number) => string;
          }).GetNameFromTypeCode;
          if (tn) itype = tn.call(a, line.type) || itype;
        }
      } catch {
        /* GUID/Typ best-effort */
      }
      const V: number[] = [];
      const F: number[] = [];
      let vbase = 0;
      const placed = mesh.geometries;
      for (let i = 0; i < placed.size(); i++) {
        const pg = placed.get(i);
        const geo = a.GetGeometry(modelID, pg.geometryExpressID);
        const verts = a.GetVertexArray(
          geo.GetVertexData(),
          geo.GetVertexDataSize(),
        );
        const idx = a.GetIndexArray(geo.GetIndexData(), geo.GetIndexDataSize());
        const mat = pg.flatTransformation;
        const nv = verts.length / 6; // 6 floats/vertex: xyz + normal
        for (let k = 0; k < nv; k++) {
          const w = applyMatrix(mat, verts[k * 6], verts[k * 6 + 1], verts[k * 6 + 2]);
          // web-ifc liefert Y-up; IFC/OpenCASCADE ist Z-up. +90°-Rotation um X
          // bringt die Geometrie zurück in den IFC-Frame: (x,y,z) -> (x,-z,y).
          // Ohne das stünde jedes Element falsch rotiert UND die globale
          // Z-Achsen-Klassifikation (Krone/Fundament/Front) griffe falsch.
          V.push(w[0], -w[2], w[1]);
        }
        for (let k = 0; k < idx.length; k++) F.push(idx[k] + vbase);
        vbase += nv;
        // GetVertexArray/GetIndexArray kopieren bereits aus dem WASM-Heap
        // (.slice(0)); die IfcGeometry wird hier nicht mehr gebraucht. Inkre-
        // mentelles Freigeben senkt den Heap-Peak beim Streamen grosser Modelle
        // (CloseModel() im finally raeumt ohnehin alles weitere ab).
        geo.delete();
      }
      if (F.length) {
        out.push({
          guid,
          ifc_type: itype,
          vertices: Float64Array.from(V),
          faces: Uint32Array.from(F),
        });
      }
    });
  } finally {
    dlog("[webifc] StreamAllMeshes done, meshes seen=", meshCount,
      "products=", out.length, "→ CloseModel");
    a.CloseModel(modelID);
  }
  return out;
}
