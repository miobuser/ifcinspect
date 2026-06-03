// On-screen 3D dimension annotations for BCF guided issues.
//
// Implements DIN ISO 129 / SIA 406 conventions: Maßlinie with Hilfslinien +
// Pfeile, plus Gefällepfeile for slope rules. All geometry is built in the
// wall's IFC frame (Z-up) and attached as a Group that the viewer adds as a
// child of sceneContent — so the annotation inherits the same -PI/2 X-axis
// rotation as the wall mesh and stays anchored to the geometry.
//
// All children carry userData.skipPick=true so the raycaster in viewer.ts
// ignores them. Render order is high so annotation overlays meshes.

import * as THREE from "three";
import type { Issue, IssueAnnotation } from "./issues";

// Bemaßungen/Pfeile + Text werden einheitlich in Akzent-Orange gezeichnet —
// KEIN Status-Farbcode (grün/rot/gelb) in der 3D-Annotation; der Status steht
// ohnehin in der BCF-Karte (Ist/Soll/Status). Linie, Pfeilkopf und Label nutzen
// alle dieselbe Farbe.
const ANNO_HEX = 0xf5a623;

// --- Label sprite ---------------------------------------------------------
// 512px wide canvas, bold 48px font, 2px black outline + 1px white inner stroke
// for Photoshop-style legibility on any background.
// Zeichnet den Maßtext auf ein Canvas und gibt Textur + Seitenverhältnis zurück
// (geteilt von Billboard-Sprite und schnittebenen-fixiertem Plane-Label).
function makeLabelTexture(text: string, hex: number): { tex: THREE.CanvasTexture; aspect: number } {
  const canvas = document.createElement("canvas");
  // SUPERSAMPLING: das Canvas wird mit SS-facher Auflösung gerendert (gleiches
  // Seitenverhältnis → gleiche Sprite-Grösse), damit der Maßtext beim Zoomen
  // gestochen scharf bleibt (quasi-vektorisierte Kanten statt verwaschener
  // Textur). Reiner Füll-Text, keine Outline/Schatten.
  const SS = 4;
  const font = `700 ${48 * SS}px 'Segoe UI', Tahoma, sans-serif`;
  const padX = 12 * SS;
  const measureCtx = canvas.getContext("2d")!;
  measureCtx.font = font;
  const tw = measureCtx.measureText(text).width;
  canvas.width = Math.ceil(tw + padX * 2);
  canvas.height = 80 * SS;
  const ctx = canvas.getContext("2d")!;
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const cx = canvas.width / 2, cy = canvas.height / 2;
  ctx.fillStyle = "#" + (hex >>> 0).toString(16).padStart(6, "0");
  ctx.fillText(text, cx, cy);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  tex.anisotropy = 8;
  tex.minFilter = THREE.LinearFilter;   // NPOT-Canvas: keine Mipmaps, scharf bleiben
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return { tex, aspect: canvas.width / canvas.height };
}

function makeLabelSprite(text: string, hex: number, worldHeight = 0.35, fixed = false): THREE.Sprite {
  const { tex, aspect } = makeLabelTexture(text, hex);
  const mat = new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(aspect * worldHeight, worldHeight, 1);
  sprite.renderOrder = 320;
  // annoFixed=true → der Per-Frame-Sprite-Loop im Viewer überspringt dieses
  // Sprite, damit die FIT-RELATIVE Größe (aus issue.view) erhalten bleibt.
  sprite.userData = { skipPick: true, aspect, annoFixed: fixed };
  return sprite;
}

// Maßtext STRIKT in der Schnittebene fixiert (kein Billboard): ein texturiertes
// Quad, dessen Normale = right×up (zur Kamera gedreht), local-X = `right`
// (parallel zur Maßlinie), local-Y = `up`. DoubleSide → von hinten gespiegelt
// sichtbar (akzeptiertes Zeichnungs-Verhalten).
function makePlaneLabel(
  text: string, hex: number, worldHeight: number,
  pos: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3,
): THREE.Mesh {
  const { tex, aspect } = makeLabelTexture(text, hex);
  const geo = new THREE.PlaneGeometry(aspect * worldHeight, worldHeight);
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(pos);
  const rN = right.clone().normalize();
  const uN = up.clone().normalize();
  const nN = new THREE.Vector3().crossVectors(rN, uN).normalize();
  mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(rN, uN, nN));
  mesh.renderOrder = 320;
  mesh.userData = { skipPick: true, annoFixed: true };
  return mesh;
}

// Orientierung in der Schnittebene: right = Maßlinien-Richtung, Normale zur
// Kamera gedreht (nicht spiegelverkehrt von vorne), up senkrecht dazu in der
// Ebene und möglichst nach oben (Welt-Z). Liefert {right, up} für makePlaneLabel.
export type LabelOrient = { planeN: THREE.Vector3; camPos: THREE.Vector3 };
function planeBasis(mid: THREE.Vector3, lineDir: THREE.Vector3, o: LabelOrient): { right: THREE.Vector3; up: THREE.Vector3 } {
  const toCam = new THREE.Vector3().subVectors(o.camPos, mid);
  const normal = o.planeN.dot(toCam) >= 0 ? o.planeN.clone() : o.planeN.clone().negate();
  let right = lineDir.clone().normalize();
  let up = new THREE.Vector3().crossVectors(normal, right).normalize();
  if (up.z < 0) { right = right.negate(); up = new THREE.Vector3().crossVectors(normal, right).normalize(); }
  return { right, up };
}

// Label platzieren: in der Schnittebene fixiert wenn `orient`, sonst Billboard.
function addLabel(
  g: THREE.Group, text: string, hex: number, worldHeight: number,
  mid: THREE.Vector3, lineDir: THREE.Vector3, orient: LabelOrient | null,
  liftFactor = 1.2,
): void {
  // Text um liftFactor·worldHeight über die Linie heben; liftFactor 0 = direkt
  // AUF der Linie (Pfeil-Annotationen), Default 1.2 = über der Maßlinie.
  const lift = worldHeight * liftFactor;
  if (orient) {
    const { right, up } = planeBasis(mid, lineDir, orient);
    const pos = mid.clone().addScaledVector(up, lift);
    g.add(makePlaneLabel(text, hex, worldHeight, pos, right, up));
  } else {
    const sprite = makeLabelSprite(text, hex, worldHeight, true);
    sprite.position.copy(mid).add(new THREE.Vector3(0, 0, lift));
    g.add(sprite);
  }
}

// FIT-RELATIVE Basisgröße: sichtbare Welt-Höhe im eingepassten Bildausschnitt
// (aus der vorberechneten issue.view: 2·dist·tan(fov/2)). Text/Pfeile werden als
// Bruchteil davon dimensioniert → korrekt für den eingepassten Screen, skaliert
// natürlich mit beim Zoomen (anders als screen-konstant).
function frameUnit(issue: Issue): number {
  const v = issue.view;
  const dx = v.cameraPos[0] - v.target[0];
  const dy = v.cameraPos[1] - v.target[1];
  const dz = v.cameraPos[2] - v.target[2];
  const dist = Math.hypot(dx, dy, dz) || 1;
  const fov = ((v.fovDeg ?? 45) * Math.PI) / 180;
  return 2 * dist * Math.tan(fov / 2);
}
// Maßtext-Höhe ≈ 2.3 % des Bildausschnitts; Pfeilkopf ≈ 1.3 %.
function fitText(unit: number): number { return Math.max(0.042, unit * 0.038); }
function fitArrow(unit: number): number { return Math.max(0.013, unit * 0.013); }

// --- Primitive: arrow head (cone) ----------------------------------------
function arrowHead(at: THREE.Vector3, towards: THREE.Vector3, size: number, hex: number): THREE.Mesh {
  const g = new THREE.ConeGeometry(size * 0.4, size, 12, 1, false);
  // Cone default: axis along +Y, tip at +Y. Orient axis along (towards-at).
  const m = new THREE.MeshBasicMaterial({ color: hex, depthTest: false });
  const mesh = new THREE.Mesh(g, m);
  const dir = new THREE.Vector3().subVectors(towards, at).normalize();
  // Place the centre of the cone half a length BEHIND `at` so the tip lands
  // exactly on `at` (the dimension-line endpoint).
  mesh.position.copy(at).addScaledVector(dir, -size * 0.5);
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(up, dir);
  mesh.quaternion.copy(q);
  mesh.renderOrder = 311;
  mesh.userData = { skipPick: true };
  return mesh;
}

// --- Primitive: full Maßlinie with Hilfslinien + Pfeile + label ----------
// `a` and `b` are the two measured points on the geometry. `offset` is the
// perpendicular vector from the geometry to the dimension line. `text` is
// the measurement value.
function dimensionLine(a: THREE.Vector3, b: THREE.Vector3, offset: THREE.Vector3, hex: number, text: string, unit: number, orient: LabelOrient | null): THREE.Group {
  const g = new THREE.Group();
  g.userData = { skipPick: true };
  const aOff = a.clone().add(offset);
  const bOff = b.clone().add(offset);
  const len = a.distanceTo(b);

  const lineMat = new THREE.LineBasicMaterial({
    color: hex, linewidth: 2, depthTest: false, transparent: true, opacity: 0.95,
  });
  // Maßlinie — exactly the measured span (endpoints carry the value length).
  // No overshoot: the line must never read longer than the value it states.
  const main = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([aOff, bOff]), lineMat,
  );
  main.renderOrder = 310;
  main.userData = { skipPick: true };
  g.add(main);
  // Hilfslinien (extension lines): mit kleiner ABSETZUNG vom Element (Lücke),
  // bis zur Maßlinie. Kein Überstand über die Maßlinie hinaus.
  const offLen = offset.length() || 1;
  // Begrenzungslinie mit nur KLEINER Lücke zum Element → die senkrechten Linien
  // sind länger und reichen fast bis zur Kante (DIN-/SIA-Maßstil).
  const gapLen = Math.min(0.015, offLen * 0.13);
  const aGap = a.clone().addScaledVector(offset, gapLen / offLen);
  const bGap = b.clone().addScaledVector(offset, gapLen / offLen);
  const ext1 = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([aGap, aOff]), lineMat,
  );
  const ext2 = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([bGap, bOff]), lineMat,
  );
  ext1.renderOrder = 310; ext2.renderOrder = 310;
  ext1.userData = { skipPick: true }; ext2.userData = { skipPick: true };
  g.add(ext1); g.add(ext2);
  // Pfeilspitzen at both ends, pointing INWARD along the Maßlinie. Sized so a
  // pair never eats more than ~⅓ of the span, with a visible floor so short
  // dimensions still clearly show arrowheads (user: "keine pfeile" before).
  // Fit-relativ, aber nie mehr als ⅓ der Maßspanne (Pfeile fressen die Linie).
  const arrowSize = Math.min(fitArrow(unit), len / 3);
  g.add(arrowHead(aOff, bOff, arrowSize, hex));
  g.add(arrowHead(bOff, aOff, arrowSize, hex));
  // Maßtext sitzt DIREKT auf der Maßlinie (mittig) — kein Schwebe-Versatz, der
  // den Text "irgendwo im Raum" über der Geometrie platziert. depthTest:false
  // hält ihn trotzdem lesbar oben.
  const mid = aOff.clone().lerp(bOff, 0.5);
  addLabel(g, text, hex, fitText(unit), mid, new THREE.Vector3().subVectors(bOff, aOff), orient);
  return g;
}

// --- Primitive: straight arrow along a face (Anzug/Krone-Gefälle) ------
// Simple architecture-plan annotation: one straight line from tail to head
// with an arrowhead at head, and a camera-facing label sprite at the
// midpoint. Used for `anzug_max` (parallel to the inclined front face) and
// `crown_slope_against_hill` (along the crown thickness direction).
function straightArrow(
  tail: THREE.Vector3,
  head: THREE.Vector3,
  label: string,
  hex: number,
  unit: number,
  orient: LabelOrient | null,
): THREE.Group {
  const g = new THREE.Group();
  g.userData = { skipPick: true };
  const lineMat = new THREE.LineBasicMaterial({
    color: hex, linewidth: 2, depthTest: false, transparent: true, opacity: 0.95,
  });
  const shaft = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([tail, head]), lineMat,
  );
  shaft.renderOrder = 310;
  shaft.userData = { skipPick: true };
  g.add(shaft);
  const len = tail.distanceTo(head);
  const arrowSize = Math.min(fitArrow(unit), len / 2.5);
  // Pfeilspitze zeigt VORWÄRTS (in tail→head-Richtung), nicht zurück zum tail.
  const fwd = head.clone().add(head.clone().sub(tail));
  g.add(arrowHead(head, fwd, arrowSize, hex));
  // MIT Schnittebene (orient, z.B. Anzug im Querschnitt): Label PARALLEL zur
  // Pfeillinie (Plane-Label), wie die Maßlinien-Texte (Default-Lift). OHNE
  // Schnittebene (z.B. Quergefälle, Schrägblick von oben): aufrechtes Billboard
  // KNAPP über der Linie (kleiner Lift) — sonst schwebt der Text hoch über dem Pfeil.
  const mid = tail.clone().lerp(head, 0.5);
  addLabel(g, label, hex, fitText(unit), mid, new THREE.Vector3().subVectors(head, tail), orient, orient ? 1.2 : 0.6);
  return g;
}

// --- 2D HTML bullet-points fallback overlay ------------------------------
// If geometry-anchored dimension is infeasible (e.g. K2 missing on the wall),
// the issue carries `bullets` and we render a small DOM panel anchored to the
// wall bbox's screen projection. This is created on demand by the wizard
// when it sees `issue.annotation?.kind === "bullets"`; the 3D group returned
// here is empty so the viewer still sees a group to mount.
function buildBulletsOverlay(issue: Issue, hex: number): THREE.Group {
  const g = new THREE.Group();
  g.userData = { skipPick: true, issueId: issue.id, bullets: true };
  // We don't try to anchor 2D HTML inside the WebGL context; the wizard's
  // BCF detail panel already shows Ist/Soll/Status. The group stays empty so
  // we don't paint a free-floating sprite "irgendwo in der Welt".
  // We DO add a small marker sprite at the wall bbox top corner so the user
  // still sees a colour-coded badge in 3D linking to the BCF card.
  const a = issue.annotation;
  if (a && a.start) {
    const sprite = makeLabelSprite(
      `${a.statusColor === "pass" ? "✓ " : a.statusColor === "fail" ? "✗ " : "● "}${a.text}`,
      hex,
    );
    sprite.position.set(...a.start);
    g.add(sprite);
  }
  return g;
}

export function buildDimensionAnnotation(issue: Issue): THREE.Group | null {
  const a = issue.annotation as IssueAnnotation | undefined;
  if (!a) return null;
  const hex = ANNO_HEX; // einheitlich Orange für Linie, Pfeilkopf und Label
  // Status icon is already baked into a.text by issues.ts; no extra prefix.
  const unit = frameUnit(issue); // fit-relative Basisgröße aus dem Bildausschnitt
  // Schnitt-Annotationen: Text STRIKT in der Schnittebene fixieren. Normale =
  // section.normal (IFC), zur Kamera gedreht. camPos aus issue.view (Welt →
  // IFC: world [x,y,z] = ifcToWorld([X,Y,Z]) = [X, Z, −Y] → invers [x, −z, y]).
  let orient: LabelOrient | null = null;
  if (issue.section) {
    const sn = issue.section.normal;
    const v = issue.view;
    orient = {
      planeN: new THREE.Vector3(sn[0], sn[1], sn[2]).normalize(),
      camPos: new THREE.Vector3(v.cameraPos[0], -v.cameraPos[2], v.cameraPos[1]),
    };
  }
  const group = new THREE.Group();
  group.userData = { skipPick: true, issueId: issue.id };
  group.renderOrder = 300;

  if (a.kind === "bullets") {
    group.add(buildBulletsOverlay(issue, hex));
    return group;
  }

  if (a.kind === "dimension") {
    const A = new THREE.Vector3(...a.start);
    const B = new THREE.Vector3(...a.end);
    const off = new THREE.Vector3(...(a.offset || [0, 0, 0.2]));
    group.add(dimensionLine(A, B, off, hex, a.text, unit, orient));
    return group;
  }

  if (a.kind === "arrow") {
    const tail = new THREE.Vector3(...a.start);
    const head = new THREE.Vector3(...a.end);
    // Ohne Schnitt (z. B. Quergefälle) wäre das Label ein kamera-folgendes Billboard
    // (view-abhängig). Stattdessen FIXIEREN: aufrechte Ebene, die die Pfeillinie
    // enthält (Normale = horizontale Senkrechte zur Pfeilrichtung), Kamerabezug aus
    // issue.view → Text bleibt beim Drehen stabil am Pfeil.
    let aOrient = orient;
    if (!aOrient) {
      const dx = head.x - tail.x, dy = head.y - tail.y;
      const hlen = Math.hypot(dx, dy);
      if (hlen > 1e-6) {
        const v = issue.view;
        aOrient = {
          planeN: new THREE.Vector3(-dy / hlen, dx / hlen, 0),
          camPos: new THREE.Vector3(v.cameraPos[0], -v.cameraPos[2], v.cameraPos[1]),
        };
      }
    }
    group.add(straightArrow(tail, head, a.text, hex, unit, aOrient));
    return group;
  }

  // issues.ts only emits dimension/arrow/bullets; nothing else reaches here.
  return null;
}
