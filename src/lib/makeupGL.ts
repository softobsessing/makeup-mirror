/**
 * makeupGL — WebGL mesh-texture warp renderer for soft AR makeup.
 *
 * Same math as the offline `warp.py` foundation, run per-frame on the GPU:
 *   • A fixed triangulation over the 468 base FaceMesh vertices.
 *   • Per-vertex CANONICAL UVs (a fixed layout) address a makeup atlas texture.
 *   • Per-frame, the vertex POSITIONS are the live landmark screen coords, so
 *     drawing the mesh warps the atlas onto whatever face is in frame.
 *
 * One atlas per tutorial step. `render()` draws ONLY the current step's atlas,
 * so each stage shows just its own guide marks (advancing to the next step
 * clears the previous step's marks).
 *
 * Imperative (not React-managed) so the 30–60fps loop never touches React
 * state, matching CameraMirror's performance contract. Draws straight-alpha
 * makeup onto a transparent canvas; the DOM composites it over the <video>.
 */

type Pt = { x: number; y: number; z?: number };

interface CanonMesh {
  uv: number[][]; // 468 × [u, v] normalized
  triangles: number[][]; // N × [i, j, k]
}

const VERT_SRC = `
attribute vec2 aPos;   // clip-space position (from live landmarks)
attribute vec2 aUV;    // canonical atlas UV
varying vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG_SRC = `
precision mediump float;
uniform sampler2D uTex;
uniform float uOpacity;
varying vec2 vUV;
void main() {
  vec4 c = texture2D(uTex, vUV);
  gl_FragColor = vec4(c.rgb, c.a * uOpacity);
}`;

// Synthetic hairline strip — MUST match warp.py's extend_forehead exactly.
const N_BASE = 468;
const FOREHEAD_ARC = [162, 21, 54, 103, 67, 109, 10, 338, 297, 332, 284, 251, 389];
const FOREHEAD_K = 0.13;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error("shader compile: " + gl.getShaderInfoLog(sh));
  }
  return sh;
}

export interface MakeupRenderer {
  /** Composite every step atlas up to `stepIndex` onto the live face. */
  render: (landmarks: Pt[], w: number, h: number, stepIndex: number, stepIds: string[]) => void;
  /** Clear to fully transparent (calibration / no face / transition). */
  clear: (w: number, h: number) => void;
  dispose: () => void;
  /** True once the mesh + at least the shader pipeline are ready. */
  isReady: () => boolean;
}

/**
 * Create a renderer bound to `canvas`. Mesh + atlas textures load async from
 * `/atlases`; `render()` is a safe no-op until the mesh is ready, and each
 * step draws only once its texture has loaded.
 */
export function createMakeupRenderer(
  canvas: HTMLCanvasElement,
  atlasUrls: Record<string, string>,
): MakeupRenderer {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: false, // we output straight alpha; DOM composites over video
    antialias: true,
  });
  if (!gl) throw new Error("WebGL unavailable");

  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT_SRC));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error("program link: " + gl.getProgramInfoLog(program));
  }

  const aPos = gl.getAttribLocation(program, "aPos");
  const aUV = gl.getAttribLocation(program, "aUV");
  const uTex = gl.getUniformLocation(program, "uTex");
  const uOpacity = gl.getUniformLocation(program, "uOpacity");

  const posBuf = gl.createBuffer()!;
  const uvBuf = gl.createBuffer()!;
  const idxBuf = gl.createBuffer()!;

  let ready = false;
  let drawCount = 0;
  let triangles: number[][] = [];
  let visibleIdx = new Uint16Array(0);
  let canonArea = new Float32Array(0); // frontal area of each triangle (UV space)
  let canonInter = 1; // canonical inter-ocular distance (for scale normalization)
  let protectedTri: boolean[] = []; // nose triangles — never foreshorten-culled
  let nVert = 0; // total vertices incl. synthetic forehead strip
  let posArray = new Float32Array(0); // clip-space positions
  let extXY = new Float32Array(0); // image-space coords (base + synthetic)
  const textures: Record<string, WebGLTexture> = {};

  // A (non-nose) triangle is dropped when its projected area falls below this
  // fraction of its frontal area — i.e. facing well away. Removes the smeared,
  // foreshortened far-side marks on a turn. The nose is exempt (it faces
  // sideways by nature, so culling it would wrongly erase the nasal contour).
  const CULL_RATIO = 0.25;

  // ---- async: load canonical mesh (UV buffer + index buffer) ----
  fetch(`${import.meta.env.BASE_URL}atlases/canonMesh.json`)
    .then((r) => r.json())
    .then((mesh: CanonMesh) => {
      nVert = mesh.uv.length;
      posArray = new Float32Array(nVert * 2);
      extXY = new Float32Array(nVert * 2);
      const uv = new Float32Array(nVert * 2);
      for (let i = 0; i < nVert; i++) {
        uv[i * 2] = mesh.uv[i][0];
        uv[i * 2 + 1] = mesh.uv[i][1];
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
      gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);

      // Store triangles with CONSISTENT winding (positive signed area in UV/
      // image space) so runtime back-face culling by signed area is uniform.
      triangles = mesh.triangles.map(([a, b, c]) => {
        const area =
          (mesh.uv[b][0] - mesh.uv[a][0]) * (mesh.uv[c][1] - mesh.uv[a][1]) -
          (mesh.uv[c][0] - mesh.uv[a][0]) * (mesh.uv[b][1] - mesh.uv[a][1]);
        return area >= 0 ? [a, b, c] : [a, c, b];
      });
      // Frontal (canonical) area per triangle + reference scale, for the
      // foreshortening test at runtime.
      canonArea = new Float32Array(triangles.length);
      triangles.forEach(([a, b, c], i) => {
        canonArea[i] = Math.abs(
          (mesh.uv[b][0] - mesh.uv[a][0]) * (mesh.uv[c][1] - mesh.uv[a][1]) -
            (mesh.uv[c][0] - mesh.uv[a][0]) * (mesh.uv[b][1] - mesh.uv[a][1]),
        );
      });
      canonInter =
        Math.hypot(mesh.uv[133][0] - mesh.uv[362][0], mesh.uv[133][1] - mesh.uv[362][1]) || 1;

      // Protect nose/inner-eye triangles from foreshorten-culling: a triangle
      // is protected if ANY vertex is a nose landmark. These regions face
      // sideways by nature, so culling them would wrongly erase the nasal
      // contour on a slight turn. Vertex-membership is symmetric + complete
      // (a bounding box missed the outer nasal triangles).
      const NOSE_SET = new Set<number>([
        168, 6, 197, 195, 5, 4, 1, 2, 19, 94,
        193, 188, 174, 198, 196, 236, 3, 51, 45, 115, 131, 209, 49, 129, 64, 98, 97, 220,
        417, 412, 399, 420, 419, 456, 281, 275, 344, 360, 429, 279, 358, 294, 327, 326, 440,
        189, 173, 133, 128, 120, 413, 398, 362, 357, 349,
      ]);
      protectedTri = triangles.map(
        ([a, b, c]) => NOSE_SET.has(a) || NOSE_SET.has(b) || NOSE_SET.has(c),
      );

      visibleIdx = new Uint16Array(triangles.length * 3);
      ready = true;
    })
    .catch((e) => console.error("[makeupGL] mesh load failed", e));

  // ---- async: load each step's atlas texture ----
  for (const [stepId, url] of Object.entries(atlasUrls)) {
    const img = new Image();
    img.onload = () => {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // FLIP_Y off: atlas row 0 (top) maps to v=0, matching our UV convention.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      textures[stepId] = tex;
    };
    img.onerror = () => console.warn("[makeupGL] atlas failed:", url);
    img.src = url;
  }

  function resize(w: number, h: number) {
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl!.viewport(0, 0, w, h);
  }

  function clear(w: number, h: number) {
    resize(w, h);
    gl!.clearColor(0, 0, 0, 0);
    gl!.clear(gl!.COLOR_BUFFER_BIT);
  }

  function render(landmarks: Pt[], w: number, h: number, stepIndex: number, stepIds: string[]) {
    if (!ready || !landmarks || landmarks.length < 468) {
      clear(w, h);
      return;
    }
    resize(w, h);
    gl!.clearColor(0, 0, 0, 0);
    gl!.clear(gl!.COLOR_BUFFER_BIT);

    // Base landmark coords (image space) + synthetic hairline strip (identical
    // rule to warp.py so the extended mesh matches the atlas).
    for (let i = 0; i < N_BASE; i++) {
      extXY[i * 2] = landmarks[i].x;
      extXY[i * 2 + 1] = landmarks[i].y;
    }
    const ux = landmarks[10].x - landmarks[152].x;
    const uy = landmarks[10].y - landmarks[152].y;
    const fh = Math.hypot(ux, uy) || 1e-6;
    for (let j = 0; j < FOREHEAD_ARC.length; j++) {
      const s = landmarks[FOREHEAD_ARC[j]];
      const v = N_BASE + j;
      extXY[v * 2] = s.x + (ux / fh) * fh * FOREHEAD_K;
      extXY[v * 2 + 1] = s.y + (uy / fh) * fh * FOREHEAD_K;
    }
    // Image space → clip space (flip Y). Un-mirrored; the parent CSS scaleX(-1)
    // mirrors it together with the video.
    for (let v = 0; v < nVert; v++) {
      posArray[v * 2] = extXY[v * 2] * 2 - 1;
      posArray[v * 2 + 1] = 1 - extXY[v * 2 + 1] * 2;
    }
    gl!.bindBuffer(gl!.ARRAY_BUFFER, posBuf);
    gl!.bufferData(gl!.ARRAY_BUFFER, posArray, gl!.DYNAMIC_DRAW);

    // Cull back-facing AND steeply-foreshortened triangles. A triangle turned
    // away from the camera projects to a much smaller (or negative) area than
    // its frontal area; when that ratio drops below CULL_RATIO we drop it, so
    // the far side of a turned face doesn't smear. `scale2` normalizes for how
    // large the face is in frame (via inter-ocular distance).
    const liveInter = Math.hypot(
      landmarks[133].x - landmarks[362].x,
      landmarks[133].y - landmarks[362].y,
    );
    const scale2 = (liveInter / canonInter) ** 2;
    let n = 0;
    for (let t = 0; t < triangles.length; t++) {
      const [a, b, c] = triangles[t];
      // Signed area from extended image-space coords (handles synthetic verts).
      const area =
        (extXY[b * 2] - extXY[a * 2]) * (extXY[c * 2 + 1] - extXY[a * 2 + 1]) -
        (extXY[c * 2] - extXY[a * 2]) * (extXY[b * 2 + 1] - extXY[a * 2 + 1]);
      // Keep if front-facing AND (a nose triangle OR not too foreshortened).
      // Back-facing (area ≤ 0) is always dropped.
      if (area > 0 && (protectedTri[t] || area > CULL_RATIO * canonArea[t] * scale2)) {
        visibleIdx[n++] = a;
        visibleIdx[n++] = b;
        visibleIdx[n++] = c;
      }
    }
    gl!.bindBuffer(gl!.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl!.bufferData(gl!.ELEMENT_ARRAY_BUFFER, visibleIdx.subarray(0, n), gl!.DYNAMIC_DRAW);
    drawCount = n;

    gl!.useProgram(program);
    gl!.enable(gl!.BLEND);
    gl!.blendFuncSeparate(
      gl!.SRC_ALPHA,
      gl!.ONE_MINUS_SRC_ALPHA,
      gl!.ONE,
      gl!.ONE_MINUS_SRC_ALPHA,
    );

    gl!.enableVertexAttribArray(aPos);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, posBuf);
    gl!.vertexAttribPointer(aPos, 2, gl!.FLOAT, false, 0, 0);

    gl!.enableVertexAttribArray(aUV);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, uvBuf);
    gl!.vertexAttribPointer(aUV, 2, gl!.FLOAT, false, 0, 0);

    gl!.bindBuffer(gl!.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl!.activeTexture(gl!.TEXTURE0);
    gl!.uniform1i(uTex, 0);

    // Show ONLY the current step's makeup — each stage replaces the previous
    // one (moving from nose contour to face contour hides the nose marks).
    const idx = Math.min(stepIndex, stepIds.length - 1);
    const tex = textures[stepIds[idx]];
    if (tex) {
      gl!.bindTexture(gl!.TEXTURE_2D, tex);
      gl!.uniform1f(uOpacity, 1.0);
      gl!.drawElements(gl!.TRIANGLES, drawCount, gl!.UNSIGNED_SHORT, 0);
    }
  }

  function dispose() {
    Object.values(textures).forEach((t) => gl!.deleteTexture(t));
    gl!.deleteBuffer(posBuf);
    gl!.deleteBuffer(uvBuf);
    gl!.deleteBuffer(idxBuf);
    gl!.deleteProgram(program);
  }

  return { render, clear, dispose, isReady: () => ready };
}
