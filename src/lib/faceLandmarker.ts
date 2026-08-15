import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

/**
 * MediaPipe asset locations — SELF-HOSTED.
 *
 * The CDN (cdn.jsdelivr.net / storage.googleapis.com) is blocked/unreachable on
 * some networks, which surfaces as a "Face model failed to load" network Event.
 * To be network-independent at runtime we serve the WASM fileset and the model
 * from the app's own /public folder.
 *
 * These files are NOT in the npm package (it ships only JS glue), so they must
 * be downloaded once into /public/mediapipe — see README ("Self-hosting the
 * MediaPipe assets"). Vite serves everything under /public at the web root, so
 * "/mediapipe/wasm" maps to public/mediapipe/wasm.
 */
const WASM_BASE_URL = `${import.meta.env.BASE_URL}mediapipe/wasm`;

const MODEL_URL = `${import.meta.env.BASE_URL}mediapipe/models/face_landmarker.task`;

/**
 * Creates and initializes a FaceLandmarker configured for live video.
 *
 * - `runningMode: "VIDEO"` enables `detectForVideo(...)` with timestamps.
 * - `numFaces: 1` — single-user makeup mirror.
 * - Transformation matrices are enabled now so we can derive head pose
 *   (yaw/pitch) for the pause-on-turn logic in a later step.
 */
export async function createFaceLandmarker(): Promise<FaceLandmarker> {
  const filesetResolver = await FilesetResolver.forVisionTasks(WASM_BASE_URL);

  return FaceLandmarker.createFromOptions(filesetResolver, {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: true,
  });
}
