"use strict";

// ============================================================
// 設定
// ============================================================

const CONFIG = {
  width: 1200,
  height: 720,
  panelWidth: 600,

  holdSeconds: 1.0,
  prepSeconds: 1.0,
  correctSeconds: 3.0,
  targetCorrect: 3,

  calibrationSeconds: 0.6,
  minVisibility: 0.45,

  assumedShoulderWidthCm: 40,
  headMoveCm: 10,
  headSmoothing: 0.55,

  mouthMarginRatio: 0.20,
  poseHandMarginRatio: 0.40,
  mouthMemorySeconds: 3,

  // 推論頻度。描画自体はrequestAnimationFrameで行います。
  inferenceIntervalMs: 100,
  soundVolume: 0.35,
};

const COLORS = {
  background: "#fff7c7",
  light: "#fffce7",
  card: "#fffad7",
  ink: "#4e4230",
  sub: "#7d6d4f",
  green: "#26974e",
  finish: "#f7f1e2",
};

const CONFETTI_COLORS = [
  "#ff6487",
  "#ffc137",
  "#46bfe9",
  "#6bcd69",
  "#b17ce5",
  "#ff934a",
  "#f183c8",
];

// [本文, ふりがな]
const QUESTIONS = [
  {
    action: "UP",
    lines: [
      [["りょう", ""], ["手", "て"], ["を", ""]],
      [["あげる", ""]],
    ],
    hints: [
      [["鼻", "はな"], ["より", ""], ["上", "うえ"], ["へ", ""]],
      [["1", ""], ["秒", "びょう"], ["ストップ", ""]],
    ],
  },
  {
    action: "RIGHT",
    lines: [
      [["右", "みぎ"], ["に", ""]],
      [["ゆれる", ""]],
    ],
    hints: [
      [["はじめの いちから", ""]],
      [["あたまを ", ""], ["右", "みぎ"], ["へ", ""]],
      [["1", ""], ["秒", "びょう"], ["ストップ", ""]],
    ],
  },
  {
    action: "LEFT",
    lines: [
      [["左", "ひだり"], ["に", ""]],
      [["ゆれる", ""]],
    ],
    hints: [
      [["はじめの いちから", ""]],
      [["あたまを ", ""], ["左", "ひだり"], ["へ", ""]],
      [["1", ""], ["秒", "びょう"], ["ストップ", ""]],
    ],
  },
  {
    action: "COVER_MOUTH",
    lines: [
      [["くちを", ""]],
      [["かくす", ""]],
    ],
    hints: [
      [["かたてでも りょうてでも", ""]],
      [["くちの まえへ", ""]],
      [["1", ""], ["秒", "びょう"], ["ストップ", ""]],
    ],
  },
];

const TITLE_BUTTON = [380, 390, 820, 535];
const FINISH_BUTTON = [300, 440, 900, 552];

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const video = document.getElementById("cameraVideo");
const actionButton = document.getElementById("actionButton");
const backButton = document.getElementById("backButton");
const notice = document.getElementById("notice");

video.muted = true;

const cameraLayer = document.createElement("canvas");
cameraLayer.width = 600;
cameraLayer.height = 720;
const cameraCtx = cameraLayer.getContext("2d");

const confettiLayer = document.createElement("canvas");
confettiLayer.width = 600;
confettiLayer.height = 720;
const confettiCtx = confettiLayer.getContext("2d");

const maskSnapshot = document.createElement("canvas");
maskSnapshot.width = 640;
maskSnapshot.height = 480;
const maskCtx = maskSnapshot.getContext("2d");

let state = "TITLE";
let stream = null;

let pose = null;
let hands = null;
let faceMesh = null;
let modelsPromise = null;

let poseLandmarks = null;
let handLandmarks = [];
let faceLandmarks = null;
let hasMask = false;

let correctCount = 0;
let questionIndex = 0;
let questionStarted = 0;
let correctStarted = 0;

let deck = [];
let previousQuestion = null;

let headReference = null;
let headSamples = [];
let calibrationStarted = null;

let holdStarted = null;
let progress = 0;
let statusText = "やってみよう！";
let filteredHeadX = null;
let lastDetectionTime = null;

let mouthMemory = {};

let particles = [];
let audioContext = null;

let inferenceBusy = false;
let lastInferenceMs = -Infinity;

// 非同期処理中に画面が切り替わったときの識別用。
let generation = 0;
let lastActionMs = -Infinity;


// ============================================================
// 共通処理
// ============================================================

function nowSeconds() {
  return performance.now() / 1000;
}

function setNotice(message, error = false) {
  notice.textContent = message;
  notice.classList.toggle("error", error);
}

function syncControls() {
  actionButton.disabled =
    state === "LOADING" || state === "CORRECT";

  const labels = {
    TITLE: "スタート！",
    LOADING: "じゅんびしています…",
    PLAY: "つぎのおだい",
    CORRECT: "できたね！",
    FINISH: "スタートがめんへ",
  };

  actionButton.textContent = labels[state];

  backButton.hidden =
    state !== "PLAY" && state !== "CORRECT";
}

function stopCamera() {
  if (stream) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }

  stream = null;
  video.srcObject = null;
}

function resetHold() {
  holdStarted = null;
  progress = 0;
}

function resetMeasurements() {
  poseLandmarks = null;
  handLandmarks = [];
  faceLandmarks = null;
  hasMask = false;
}

function returnToTitle() {
  generation += 1;
  state = "TITLE";

  stopCamera();
  resetMeasurements();
  resetHold();

  particles = [];
  correctCount = 0;
  headReference = null;
  mouthMemory = {};

  lastActionMs = performance.now();

  syncControls();
  setNotice("iPadを横向きにすると遊びやすいです。");
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function nextQuestionIndex() {
  if (deck.length === 0) {
    deck = QUESTIONS.map((_, index) => index);

    for (let i = deck.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    if (
      deck.length > 1 &&
      deck[deck.length - 1] === previousQuestion
    ) {
      const last = deck.length - 1;
      [deck[0], deck[last]] = [deck[last], deck[0]];
    }
  }

  previousQuestion = deck.pop();
  return previousQuestion;
}

function startQuestion() {
  generation += 1;

  questionIndex = nextQuestionIndex();
  questionStarted = nowSeconds();

  filteredHeadX = null;
  lastDetectionTime = null;
  mouthMemory = {};

  resetHold();

  statusText = "じゅんびしてね";
  state = "PLAY";

  syncControls();
}


// ============================================================
// MediaPipe
// ============================================================

async function ensureModels() {
  if (modelsPromise) {
    return modelsPromise;
  }

  modelsPromise = (async () => {
    if (
      typeof window.Pose !== "function" ||
      typeof window.Hands !== "function" ||
      typeof window.FaceMesh !== "function"
    ) {
      throw new Error(
        "MediaPipeを読み込めません。インターネット接続を確認してください。"
      );
    }

    pose = new window.Pose({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${file}`,
    });

    pose.setOptions({
      modelComplexity: 1,
      smoothLandmarks: true,
      enableSegmentation: true,
      smoothSegmentation: true,
      minDetectionConfidence: 0.45,
      minTrackingConfidence: 0.45,
    });

    pose.onResults((results) => {
      poseLandmarks = results.poseLandmarks || null;

      hasMask = Boolean(results.segmentationMask);

      if (hasMask) {
        maskCtx.clearRect(0, 0, 640, 480);
        maskCtx.drawImage(
          results.segmentationMask,
          0,
          0,
          640,
          480
        );
      }
    });

    hands = new window.Hands({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`,
    });

    hands.setOptions({
      maxNumHands: 2,
      modelComplexity: 0,
      minDetectionConfidence: 0.35,
      minTrackingConfidence: 0.35,
    });

    hands.onResults((results) => {
      handLandmarks = results.multiHandLandmarks || [];
    });

    faceMesh = new window.FaceMesh({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/${file}`,
    });

    faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: false,
      minDetectionConfidence: 0.40,
      minTrackingConfidence: 0.40,
    });

    faceMesh.onResults((results) => {
      faceLandmarks =
        results.multiFaceLandmarks?.[0] || null;
    });

    // 同時初期化による負荷を避け、順番に初期化します。
    await pose.initialize();
    await hands.initialize();
    await faceMesh.initialize();
  })();

  try {
    await modelsPromise;
  } catch (error) {
    for (const model of [pose, hands, faceMesh]) {
      try {
        await model?.close();
      } catch {
        // 初期化失敗時の後処理エラーは無視します。
      }
    }

    pose = null;
    hands = null;
    faceMesh = null;
    modelsPromise = null;

    throw error;
  }
}


// ============================================================
// カメラ開始
// ============================================================

async function startGame() {
  if (state !== "TITLE") {
    return;
  }

  if (
    !window.isSecureContext ||
    !navigator.mediaDevices?.getUserMedia
  ) {
    setNotice(
      "カメラを使うには、HTTPSで公開したページをSafariで開いてください。",
      true
    );
    return;
  }

  // 音声をユーザー操作の中で有効にします。
  unlockAudio();

  state = "LOADING";
  const token = ++generation;

  syncControls();
  setNotice(
    "カメラを許可してください。初回はモデルの読み込みに時間がかかります。"
  );

  try {
    const newStream =
      await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 24, max: 30 },
        },
      });

    if (token !== generation) {
      newStream.getTracks().forEach((track) => track.stop());
      return;
    }

    stream = newStream;
    video.srcObject = stream;

    await video.play();
    await ensureModels();

    if (token !== generation) {
      return;
    }

    resetMeasurements();

    correctCount = 0;
    deck = [];
    previousQuestion = null;

    headReference = null;
    headSamples = [];
    calibrationStarted = null;

    lastInferenceMs = -Infinity;

    startQuestion();

    setNotice(
      "顔と両肩を映して、はじめの位置で少し止まってね。"
    );
  } catch (error) {
    if (token !== generation) {
      return;
    }

    stopCamera();
    state = "TITLE";
    syncControls();

    let message = error.message || "開始できませんでした。";

    if (error.name === "NotAllowedError") {
      message =
        "カメラが許可されていません。Safariのサイト設定でカメラを許可してください。";
    } else if (error.name === "NotFoundError") {
      message = "使用できるカメラが見つかりません。";
    } else if (error.name === "NotReadableError") {
      message =
        "カメラを開始できません。他のカメラ使用アプリを閉じてください。";
    }

    setNotice(message, true);
    console.error(error);
  }
}


// ============================================================
// ランドマークの計測
// 推論は元映像、判定座標は鏡表示に合わせてxを反転。
// ============================================================

function landmarkPoint(
  landmarks,
  index,
  visibility = CONFIG.minVisibility
) {
  const point = landmarks?.[index];

  if (!point) {
    return null;
  }

  if (
    typeof point.visibility === "number" &&
    point.visibility < visibility
  ) {
    return null;
  }

  if (
    point.x < 0 || point.x > 1 ||
    point.y < 0 || point.y > 1
  ) {
    return null;
  }

  return { x: 1 - point.x, y: point.y };
}

function midpoint(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

function measure() {
  const leftShoulder = landmarkPoint(poseLandmarks, 11);
  const rightShoulder = landmarkPoint(poseLandmarks, 12);

  let width = null;
  let center = null;

  if (leftShoulder && rightShoulder) {
    const measured =
      Math.abs(leftShoulder.x - rightShoulder.x);

    if (measured >= 0.04) {
      width = measured;
      center = midpoint(leftShoulder, rightShoulder);
    }
  }

  let nose = landmarkPoint(poseLandmarks, 0);

  const mouthLeft = landmarkPoint(poseLandmarks, 9, 0.20);
  const mouthRight = landmarkPoint(poseLandmarks, 10, 0.20);

  let mouth =
    mouthLeft && mouthRight
      ? midpoint(mouthLeft, mouthRight)
      : null;

  let faceWidth = width !== null ? width * 0.42 : null;

  if (faceLandmarks) {
    const upperLip = landmarkPoint(faceLandmarks, 13, 0);
    const lowerLip = landmarkPoint(faceLandmarks, 14, 0);

    if (upperLip && lowerLip) {
      mouth = midpoint(upperLip, lowerLip);
    }

    nose ||= landmarkPoint(faceLandmarks, 1, 0);

    const a = landmarkPoint(faceLandmarks, 234, 0);
    const b = landmarkPoint(faceLandmarks, 454, 0);

    if (a && b) {
      const measured = Math.abs(a.x - b.x);

      if (measured >= 0.025) {
        faceWidth = measured;
      }
    }
  }

  const preciseHands = handLandmarks.map((hand) =>
    hand.map((point) => ({
      x: 1 - point.x,
      y: point.y,
    }))
  );

  const poseHands = [
    [15, 19, 17, 21],
    [16, 20, 18, 22],
  ].map((indices) =>
    indices
      .map((index) =>
        landmarkPoint(poseLandmarks, index, 0.20)
      )
      .filter(Boolean)
  );

  return {
    nose,
    mouth,
    center,
    width,
    faceWidth,
    leftWrist: landmarkPoint(poseLandmarks, 15),
    rightWrist: landmarkPoint(poseLandmarks, 16),
    hands: preciseHands,
    poseHands,
    frameWidth: video.videoWidth || 640,
    frameHeight: video.videoHeight || 480,
  };
}


// ============================================================
// 開始位置の保存
// ============================================================

function updateHeadReference(data, now) {
  if (headReference) {
    return true;
  }

  if (!data.nose || data.width === null) {
    headSamples = [];
    calibrationStarted = null;
    return false;
  }

  const sample = {
    x: data.nose.x,
    width: data.width,
  };

  if (headSamples.length > 0) {
    const first = headSamples[0];
    const tolerance = Math.max(0.008, first.width * 0.06);

    if (Math.abs(sample.x - first.x) > tolerance) {
      headSamples = [];
      calibrationStarted = null;
    }
  }

  if (calibrationStarted === null) {
    calibrationStarted = now;
  }

  headSamples.push(sample);

  if (
    now - calibrationStarted >= CONFIG.calibrationSeconds
  ) {
    headReference = {
      x: median(headSamples.map((item) => item.x)),
      width: median(headSamples.map((item) => item.width)),
    };

    headSamples = [];
    questionStarted = now;

    setNotice(
      "開始位置を記録しました。お題のポーズをとってね。"
    );

    return true;
  }

  return false;
}


// ============================================================
// 隠れた口の位置を補完
// ============================================================

function trackedMouth(data, now) {
  const memory = mouthMemory;

  if (data.faceWidth !== null) {
    memory.faceWidth = data.faceWidth;
  }

  if (data.mouth) {
    memory.seenAt = now;
    memory.mouth = { ...data.mouth };

    if (data.nose && memory.faceWidth) {
      memory.noseOffset = {
        x: (data.mouth.x - data.nose.x) / memory.faceWidth,
        y: (data.mouth.y - data.nose.y) / memory.faceWidth,
      };
    }

    if (data.center && data.width) {
      memory.centerOffset = {
        x: (data.mouth.x - data.center.x) / data.width,
        y: (data.mouth.y - data.center.y) / data.width,
      };
    }

    return {
      mouth: data.mouth,
      faceWidth: memory.faceWidth,
    };
  }

  if (
    memory.seenAt !== undefined &&
    now - memory.seenAt <= CONFIG.mouthMemorySeconds
  ) {
    if (
      data.nose &&
      memory.noseOffset &&
      memory.faceWidth
    ) {
      return {
        mouth: {
          x:
            data.nose.x +
            memory.noseOffset.x * memory.faceWidth,
          y:
            data.nose.y +
            memory.noseOffset.y * memory.faceWidth,
        },
        faceWidth: memory.faceWidth,
      };
    }

    if (
      data.center &&
      data.width &&
      memory.centerOffset
    ) {
      return {
        mouth: {
          x:
            data.center.x +
            memory.centerOffset.x * data.width,
          y:
            data.center.y +
            memory.centerOffset.y * data.width,
        },
        faceWidth: memory.faceWidth,
      };
    }

    if (memory.mouth) {
      return {
        mouth: memory.mouth,
        faceWidth: memory.faceWidth,
      };
    }
  }

  if (data.nose && memory.faceWidth) {
    const aspect = data.frameWidth / data.frameHeight;

    return {
      mouth: {
        x: data.nose.x,
        y:
          data.nose.y +
          memory.faceWidth * 0.32 * aspect,
      },
      faceWidth: memory.faceWidth,
    };
  }

  return {
    mouth: null,
    faceWidth: memory.faceWidth || null,
  };
}


// ============================================================
// 手の領域と口の距離
// ============================================================

function cross(o, a, b) {
  return (
    (a.x - o.x) * (b.y - o.y) -
    (a.y - o.y) * (b.x - o.x)
  );
}

function convexHull(points) {
  const sorted = [...points].sort(
    (a, b) => a.x - b.x || a.y - b.y
  );

  if (sorted.length <= 2) {
    return sorted;
  }

  const lower = [];

  for (const point of sorted) {
    while (
      lower.length >= 2 &&
      cross(
        lower[lower.length - 2],
        lower[lower.length - 1],
        point
      ) <= 0
    ) {
      lower.pop();
    }

    lower.push(point);
  }

  const upper = [];

  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i];

    while (
      upper.length >= 2 &&
      cross(
        upper[upper.length - 2],
        upper[upper.length - 1],
        point
      ) <= 0
    ) {
      upper.pop();
    }

    upper.push(point);
  }

  lower.pop();
  upper.pop();

  return lower.concat(upper);
}

function pointInPolygon(point, polygon) {
  let inside = false;

  for (
    let i = 0, j = polygon.length - 1;
    i < polygon.length;
    j = i++
  ) {
    const a = polygon[i];
    const b = polygon[j];

    if (
      (a.y > point.y) !== (b.y > point.y) &&
      point.x <
        ((b.x - a.x) * (point.y - a.y)) /
          (b.y - a.y) +
        a.x
    ) {
      inside = !inside;
    }
  }

  return inside;
}

function segmentDistance(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared < 1e-8) {
    return Math.hypot(point.x - a.x, point.y - a.y);
  }

  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - a.x) * dx + (point.y - a.y) * dy) /
        lengthSquared
    )
  );

  return Math.hypot(
    point.x - (a.x + t * dx),
    point.y - (a.y + t * dy)
  );
}

function handNearMouth(points, mouth, faceWidth, data, ratio) {
  if (!mouth || !faceWidth || points.length === 0) {
    return false;
  }

  const pixels = points.map((point) => ({
    x: point.x * data.frameWidth,
    y: point.y * data.frameHeight,
  }));

  const mouthPixels = {
    x: mouth.x * data.frameWidth,
    y: mouth.y * data.frameHeight,
  };

  const margin = Math.max(
    8,
    faceWidth * data.frameWidth * ratio
  );

  const hull = convexHull(pixels);

  if (
    hull.length >= 3 &&
    pointInPolygon(mouthPixels, hull)
  ) {
    return true;
  }

  let minimum = Infinity;

  for (let i = 0; i < hull.length; i += 1) {
    minimum = Math.min(
      minimum,
      segmentDistance(
        mouthPixels,
        hull[i],
        hull[(i + 1) % hull.length]
      )
    );
  }

  return minimum <= margin;
}


// ============================================================
// 動作判定
// ============================================================

function updateDetector(data, now) {
  if (
    lastDetectionTime !== null &&
    now - lastDetectionTime > 0.75
  ) {
    resetHold();
    filteredHeadX = null;

    if (!headReference) {
      headSamples = [];
      calibrationStarted = null;
    }
  }

  lastDetectionTime = now;

  const action = QUESTIONS[questionIndex].action;

  // 準備中から口の位置を記憶します。
  const mouthData =
    action === "COVER_MOUTH"
      ? trackedMouth(data, now)
      : null;

  if (!headReference) {
    updateHeadReference(data, now);
    resetHold();

    statusText = headReference
      ? "じゅんびしてね"
      : "はじめの いちで ストップ";

    return;
  }

  if (now - questionStarted < CONFIG.prepSeconds) {
    resetHold();
    statusText = "じゅんびしてね";
    return;
  }

  let matched = false;
  statusText = "やってみよう！";

  if (action === "UP") {
    if (
      data.nose &&
      data.leftWrist &&
      data.rightWrist
    ) {
      matched =
        data.leftWrist.y < data.nose.y - 0.015 &&
        data.rightWrist.y < data.nose.y - 0.015;
    } else {
      statusText = "かおと てくびを うつしてね";
    }
  }

  if (action === "LEFT" || action === "RIGHT") {
    if (!data.nose) {
      filteredHeadX = null;
      statusText = "あたまを カメラにうつしてね";
    } else {
      filteredHeadX =
        filteredHeadX === null
          ? data.nose.x
          : CONFIG.headSmoothing * data.nose.x +
            (1 - CONFIG.headSmoothing) * filteredHeadX;

      const moveLimit =
        headReference.width *
        CONFIG.headMoveCm /
        CONFIG.assumedShoulderWidthCm;

      const movement = filteredHeadX - headReference.x;

      if (action === "LEFT") {
        matched = movement <= -moveLimit;
        statusText = "あたまを ひだりへ";
      } else {
        matched = movement >= moveLimit;
        statusText = "あたまを みぎへ";
      }
    }
  }

  if (action === "COVER_MOUTH") {
    const { mouth, faceWidth } = mouthData;

    if (!mouth || !faceWidth) {
      statusText = "まず かおを みせてね";
    } else {
      matched = data.hands.some((hand) =>
        handNearMouth(
          hand,
          mouth,
          faceWidth,
          data,
          CONFIG.mouthMarginRatio
        )
      );

      if (!matched) {
        matched = data.poseHands.some((hand) =>
          handNearMouth(
            hand,
            mouth,
            faceWidth,
            data,
            CONFIG.poseHandMarginRatio
          )
        );
      }

      if (!matched) {
        const hasHand =
          data.hands.length > 0 ||
          data.poseHands.some((hand) => hand.length > 0);

        statusText = hasHand
          ? "てを くちのまえへ"
          : "てのひらを カメラにみせてね";
      }
    }
  }

  if (!matched) {
    resetHold();
    return;
  }

  if (holdStarted === null) {
    holdStarted = now;
  }

  progress = Math.min(
    (now - holdStarted) / CONFIG.holdSeconds,
    1
  );

  statusText = "そのまま ストップ！";

  if (progress >= 1) {
    correctCount += 1;
    correctStarted = now;

    state = "CORRECT";
    generation += 1;

    startConfetti();
    playCorrectSound();
    syncControls();
  }
}


// ============================================================
// 正解音：Web Audio API
// ============================================================

function unlockAudio() {
  try {
    const AudioContextClass =
      window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
      return;
    }

    audioContext ||= new AudioContextClass();

    audioContext.resume().catch(() => {});

    // iOS向けに短い無音を再生します。
    const buffer = audioContext.createBuffer(
      1,
      1,
      audioContext.sampleRate
    );

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.start();
  } catch (error) {
    console.warn("音声を有効にできませんでした。", error);
  }
}

function playCorrectSound() {
  if (!audioContext || audioContext.state !== "running") {
    return;
  }

  const start = audioContext.currentTime;

  for (const [frequency, delay, duration] of [
    [1046.50, 0, 0.40],
    [783.99, 0.24, 0.58],
  ]) {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();

    oscillator.type = "sine";
    oscillator.frequency.value = frequency;

    const time = start + delay;

    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(
      CONFIG.soundVolume * 0.45,
      time + 0.008
    );
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      time + duration
    );

    oscillator.connect(gain);
    gain.connect(audioContext.destination);

    oscillator.start(time);
    oscillator.stop(time + duration + 0.02);

    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  }
}


// ============================================================
// 描画の基本
// ============================================================

const FONT =
  '"Hiragino Maru Gothic ProN", "Hiragino Sans", sans-serif';

function text(
  value,
  x,
  y,
  size,
  color = COLORS.ink,
  weight = 600
) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText(value, x, y);
}

function roundedBox(
  context,
  box,
  radius,
  fill,
  stroke = COLORS.ink,
  lineWidth = 3
) {
  const [x1, y1, x2, y2] = box;
  const r = Math.min(
    radius,
    (x2 - x1) / 2,
    (y2 - y1) / 2
  );

  context.beginPath();
  context.moveTo(x1 + r, y1);

  context.arcTo(x2, y1, x2, y2, r);
  context.arcTo(x2, y2, x1, y2, r);
  context.arcTo(x1, y2, x1, y1, r);
  context.arcTo(x1, y1, x2, y1, r);

  context.closePath();

  if (fill) {
    context.fillStyle = fill;
    context.fill();
  }

  if (stroke) {
    context.strokeStyle = stroke;
    context.lineWidth = lineWidth;
    context.stroke();
  }
}

function rubyLine(parts, centerX, top, size, rubySize, color) {
  const widths = parts.map(([base, ruby]) => {
    ctx.font = `600 ${size}px ${FONT}`;
    const baseWidth = ctx.measureText(base).width;

    ctx.font = `600 ${rubySize}px ${FONT}`;
    const rubyWidth = ruby ? ctx.measureText(ruby).width : 0;

    return Math.max(baseWidth, rubyWidth);
  });

  let x =
    centerX -
    widths.reduce((sum, width) => sum + width, 0) / 2;

  parts.forEach(([base, ruby], index) => {
    const center = x + widths[index] / 2;

    if (ruby) {
      text(
        ruby,
        center,
        top + rubySize / 2,
        rubySize,
        color
      );
    }

    text(
      base,
      center,
      top + rubySize + 7 + size / 2,
      size,
      color
    );

    x += widths[index];
  });
}

function background(color = COLORS.background) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1200, 720);
}

function outerBorder() {
  roundedBox(
    ctx,
    [10, 10, 1190, 710],
    24,
    null,
    COLORS.ink,
    4
  );
}

function drawPerson(centerX, bottom, scale = 1) {
  ctx.save();
  ctx.translate(centerX, bottom);
  ctx.scale(scale, scale);

  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.fillStyle = COLORS.light;
  ctx.beginPath();
  ctx.arc(0, -160, 45, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(-30, -120);
  ctx.lineTo(-45, -70);
  ctx.lineTo(-40, 0);
  ctx.lineTo(40, 0);
  ctx.lineTo(45, -70);
  ctx.lineTo(30, -120);
  ctx.stroke();

  for (const direction of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(direction * 35, -112);
    ctx.lineTo(direction * 72, -160);
    ctx.lineTo(direction * 85, -235);
    ctx.stroke();

    for (let finger = 0; finger < 4; finger += 1) {
      ctx.beginPath();
      ctx.moveTo(direction * (74 + finger * 6), -230);
      ctx.lineTo(
        direction * (72 + finger * 8),
        -251 - (finger % 2) * 9
      );
      ctx.stroke();
    }
  }

  ctx.fillStyle = COLORS.ink;

  for (const x of [-15, 15]) {
    ctx.beginPath();
    ctx.arc(x, -165, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(0, -153, 16, 0.15, Math.PI - 0.15);
  ctx.stroke();

  ctx.restore();
}


// ============================================================
// タイトル・完了画面
// ============================================================

function drawTitle() {
  background();
  outerBorder();

  text("ポーズでクリア", 600, 225, 70);

  roundedBox(ctx, TITLE_BUTTON, 45, COLORS.light);
  text("スタート！", 600, 458, 49);

  text(
    "ボタンをタップしてスタート",
    600,
    582,
    25,
    COLORS.sub
  );

  text(
    "カメラのまえに たってね",
    600,
    650,
    21,
    COLORS.sub
  );

  drawPerson(155, 640, 1.05);
  drawPerson(1045, 640, 1.05);

  for (let i = 0; i < 22; i += 1) {
    const x = 55 + ((i * 137) % 1090);
    const y = 55 + ((i * 31) % 80);

    ctx.strokeStyle = CONFETTI_COLORS[i % 7];
    ctx.lineWidth = 5;

    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 7, y + 14);
    ctx.stroke();
  }
}

function drawLoading() {
  background();
  outerBorder();

  text("カメラをじゅんびしています", 600, 310, 42);

  text(
    "カメラのまえに たってね",
    600,
    410,
    29,
    COLORS.sub
  );
}

function drawFinish() {
  background(COLORS.finish);
  outerBorder();

  // システムの絵文字フォントで両手を表示します。
  ctx.save();
  ctx.font = '92px "Apple Color Emoji", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("🙌", 600, 185);
  ctx.restore();

  text("よくできました！", 600, 287, 69);

  roundedBox(
    ctx,
    FINISH_BUTTON,
    29,
    "#fffffc",
    "#26221e",
    3
  );

  text(
    "ぼたんをおして　せんせいにほうこく",
    600,
    496,
    30,
    "#26221e"
  );

  text(
    `${CONFIG.targetCorrect}もん できたら クリア！`,
    600,
    578,
    20,
    COLORS.sub
  );

  text(
    "ボタンをタップすると スタートがめんへ",
    600,
    624,
    20,
    COLORS.sub
  );
}


// ============================================================
// 指示パネル
// ============================================================

function drawPanel(now) {
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, 600, 720);

  text(
    `できた！  ${correctCount} / ${CONFIG.targetCorrect}`,
    300,
    47,
    24,
    COLORS.sub
  );

  roundedBox(
    ctx,
    [35, 87, 565, 337],
    42,
    COLORS.card
  );

  const question = QUESTIONS[questionIndex];

  question.lines.forEach((parts, index) => {
    rubyLine(
      parts,
      300,
      121 + index * 105,
      62,
      23,
      COLORS.ink
    );
  });

  if (state === "CORRECT") {
    const elapsed = now - correctStarted;

    ctx.save();
    ctx.globalAlpha =
      0.35 +
      0.65 * (0.5 + 0.5 * Math.cos(elapsed * Math.PI * 2 / 1.6));

    ctx.strokeStyle = COLORS.green;
    ctx.lineWidth = 7;

    ctx.beginPath();
    ctx.ellipse(300, 488, 129, 107, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();

    rubyLine(
      [["正解", "せいかい"]],
      300,
      438,
      68,
      23,
      COLORS.green
    );

    text("できたね！", 300, 621, 24, COLORS.green);
  } else {
    const firstY = question.hints.length === 3 ? 385 : 408;

    question.hints.forEach((parts, index) => {
      rubyLine(
        parts,
        300,
        firstY + index * 66,
        30,
        17,
        COLORS.ink
      );
    });

    text(statusText, 300, 596, 22, COLORS.sub);

    roundedBox(
      ctx,
      [95, 629, 505, 643],
      7,
      "#e8deaf",
      null
    );

    if (progress > 0) {
      roundedBox(
        ctx,
        [95, 629, 95 + Math.max(14, 410 * progress), 643],
        7,
        COLORS.green,
        null
      );
    }
  }

  text(
    "「つぎのおだい」で スキップ",
    300,
    681,
    20,
    COLORS.sub
  );
}


// ============================================================
// カメラ映像を鏡表示して、右パネルに配置
// ============================================================

function drawFittedMirror(context, source) {
  const sourceWidth =
    source.videoWidth || source.width || 640;

  const sourceHeight =
    source.videoHeight || source.height || 480;

  const scale = Math.max(
    600 / sourceWidth,
    720 / sourceHeight
  );

  const width = sourceWidth * scale;
  const height = sourceHeight * scale;

  const x = (600 - width) / 2;
  const y = (720 - height) / 2;

  context.save();
  context.translate(600, 0);
  context.scale(-1, 1);
  context.drawImage(source, x, y, width, height);
  context.restore();
}

function drawCamera(now) {
  cameraCtx.fillStyle = COLORS.light;
  cameraCtx.fillRect(0, 0, 600, 720);

  if (video.readyState >= 2 && video.videoWidth > 0) {
    drawFittedMirror(cameraCtx, video);
  }

  if (state === "CORRECT") {
    drawConfetti(now - correctStarted);
    cameraCtx.drawImage(confettiLayer, 0, 0);
  }

  ctx.drawImage(cameraLayer, 600, 0);
}


// ============================================================
// 紙吹雪：人物マスクで人物の前を透明にする
// ============================================================

function startConfetti() {
  particles = Array.from({ length: 115 }, () => ({
    x: Math.random() * 600,
    y: Math.random() * 820 - 100,

    speed: 90 + Math.random() * 120,
    drift: Math.random() * 50 - 25,
    sway: 12 + Math.random() * 25,

    phase: Math.random() * Math.PI * 2,
    rotation: Math.random() * Math.PI * 2,
    spin: Math.random() * 8 - 4,

    width: 8 + Math.random() * 9,
    height: 5 + Math.random() * 6,

    color:
      CONFETTI_COLORS[
        Math.floor(Math.random() * CONFETTI_COLORS.length)
      ],
  }));
}

function drawConfetti(elapsed) {
  confettiCtx.clearRect(0, 0, 600, 720);

  for (const particle of particles) {
    const rawX =
      particle.x +
      particle.drift * elapsed +
      particle.sway *
        Math.sin(elapsed * 2.1 + particle.phase);

    const x = ((rawX % 600) + 600) % 600;

    const y =
      ((particle.y + particle.speed * elapsed + 100) % 820) -
      100;

    const angle =
      particle.rotation + particle.spin * elapsed;

    const width =
      particle.width *
      (0.3 + 0.7 * Math.abs(Math.cos(angle)));

    confettiCtx.save();
    confettiCtx.translate(x, y);
    confettiCtx.rotate(angle);

    confettiCtx.fillStyle = particle.color;
    confettiCtx.fillRect(
      -width / 2,
      -particle.height / 2,
      width,
      particle.height
    );

    confettiCtx.restore();
  }

  if (hasMask) {
    confettiCtx.save();

    // 人物領域を紙吹雪から取り除きます。
    confettiCtx.globalCompositeOperation = "destination-out";
    drawFittedMirror(confettiCtx, maskSnapshot);

    confettiCtx.restore();
  }
}


// ============================================================
// 非同期推論
// ============================================================

async function runInference() {
  const token = generation;
  const currentState = state;
  const action = QUESTIONS[questionIndex].action;

  try {
    await pose.send({ image: video });

    if (token !== generation) {
      return;
    }

    if (
      currentState === "PLAY" &&
      action === "COVER_MOUTH"
    ) {
      await hands.send({ image: video });

      if (token !== generation) {
        return;
      }

      await faceMesh.send({ image: video });

      if (token !== generation) {
        return;
      }
    } else {
      handLandmarks = [];
      faceLandmarks = null;
    }

    if (state === "PLAY") {
      updateDetector(measure(), nowSeconds());
    }
  } catch (error) {
    if (token === generation) {
      returnToTitle();

      setNotice(
        "姿勢の検出に失敗しました。ページを再読み込みして試してください。",
        true
      );
    }

    console.error(error);
  } finally {
    inferenceBusy = false;
  }
}


// ============================================================
// 描画ループ
// ============================================================

function renderLoop(timestamp) {
  const now = timestamp / 1000;

  if (
    state === "CORRECT" &&
    now - correctStarted >= CONFIG.correctSeconds
  ) {
    if (correctCount >= CONFIG.targetCorrect) {
      state = "FINISH";
      generation += 1;

      // 完了画面ではカメラを停止して省電力化します。
      stopCamera();
      syncControls();

      setNotice(
        "よくできました！ボタンを押して先生に報告してね。"
      );
    } else {
      startQuestion();
    }
  }

  if (state === "TITLE") {
    drawTitle();
  } else if (state === "LOADING") {
    drawLoading();
  } else if (state === "FINISH") {
    drawFinish();
  } else {
    drawPanel(now);
    drawCamera(now);
    outerBorder();

    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 5;

    ctx.beginPath();
    ctx.moveTo(600, 10);
    ctx.lineTo(600, 710);
    ctx.stroke();

    if (
      !inferenceBusy &&
      pose &&
      video.readyState >= 2 &&
      timestamp - lastInferenceMs >=
        CONFIG.inferenceIntervalMs
    ) {
      inferenceBusy = true;
      lastInferenceMs = timestamp;

      void runInference();
    }
  }

  requestAnimationFrame(renderLoop);
}


// ============================================================
// タッチ・クリック・キーボード
// ============================================================

function insideRoundedButton(x, y, box, radius) {
  const [x1, y1, x2, y2] = box;

  if (x < x1 || x > x2 || y < y1 || y > y2) {
    return false;
  }

  const nearestX = Math.min(
    Math.max(x, x1 + radius),
    x2 - radius
  );

  const nearestY = Math.min(
    Math.max(y, y1 + radius),
    y2 - radius
  );

  return (
    (x - nearestX) ** 2 +
      (y - nearestY) ** 2 <=
    radius ** 2
  );
}

function handleAction() {
  const time = performance.now();

  if (time - lastActionMs < 450) {
    return;
  }

  lastActionMs = time;

  if (state === "TITLE") {
    void startGame();
  } else if (state === "PLAY") {
    startQuestion();
  } else if (state === "FINISH") {
    returnToTitle();
  }
}

actionButton.addEventListener("click", handleAction);

backButton.addEventListener("click", returnToTitle);

canvas.addEventListener("click", (event) => {
  const rect = canvas.getBoundingClientRect();

  // CSSで縮小されたCanvas座標を、内部座標に変換します。
  const x =
    (event.clientX - rect.left) *
    canvas.width /
    rect.width;

  const y =
    (event.clientY - rect.top) *
    canvas.height /
    rect.height;

  if (
    state === "TITLE" &&
    insideRoundedButton(x, y, TITLE_BUTTON, 45)
  ) {
    handleAction();
  } else if (
    state === "FINISH" &&
    insideRoundedButton(x, y, FINISH_BUTTON, 29)
  ) {
    handleAction();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.repeat) {
    return;
  }

  const key = event.key.toLowerCase();

  if (key === "d") {
    event.preventDefault();
    handleAction();
  } else if (key === "q" || key === "escape") {
    event.preventDefault();
    returnToTitle();
  }
});

// 別タブに移動した場合は、誤判定を防ぐためタイトルへ戻します。
document.addEventListener("visibilitychange", () => {
  if (document.hidden && state !== "TITLE") {
    returnToTitle();
  }
});

window.addEventListener("pagehide", () => {
  generation += 1;
  stopCamera();
});

// 初期表示
syncControls();
requestAnimationFrame(renderLoop);
