// Built-in question sets. Short instructions and null descriptions keep prompts small:
// latency grows with prompt length, and image tokens already dominate it.

export const PRESETS = [
  {
    id: "desk",
    name: "Desk companion",
    blurb: "Who is there, what they are doing, and the hand sign they show.",
    state: "A live frame from a laptop webcam.",
    questions: {
      presence: {
        type: "choice",
        instructions: "Who is in frame?",
        criteria: { nobody: null, one_person: null, several_people: null },
      },
      activity: {
        type: "choice",
        instructions: "What is the main person doing?",
        criteria: {
          typing: "hands on a keyboard",
          reading: "eyes on the screen, hands still",
          scrolling_phone: null,
          drinking: null,
          speaking: "talking or gesturing",
          stretching: null,
        },
      },
      hand_sign: {
        type: "choice",
        instructions: "Hand sign shown to the camera?",
        criteria: { open_palm: null, thumbs_up: null, thumbs_down: null, ok_sign: null, victory: null, none: null },
      },
      mood: {
        type: "score",
        instructions: "How positive does the face look?",
        criteria: ["upset or frowning", "neutral", "slight smile", "big smile or laughing"],
      },
      eye_contact: { type: "noul", instructions: "Is the person looking straight into the camera?" },
    },
  },
  {
    id: "focus",
    name: "Focus monitor",
    blurb: "Depth of focus, posture, and the usual distractions.",
    state: "A live frame of someone at their desk.",
    questions: {
      focus: {
        type: "score",
        instructions: "How focused on their work is the person?",
        criteria: ["not working", "distracted", "working", "deep focus"],
      },
      phone_in_hand: { type: "noul", instructions: "Is the person holding a phone?" },
      posture: {
        type: "choice",
        instructions: "Posture?",
        criteria: { upright: null, slouching: null, leaning_in: "close to the screen", leaning_back: null, not_visible: null },
      },
      eyes_closed: { type: "noul", instructions: "Are the person's eyes closed?" },
    },
  },
  {
    id: "expression",
    name: "Expressions",
    blurb: "Basic emotions, their intensity, and the mouth.",
    state: "A live frame showing a face.",
    questions: {
      emotion: {
        type: "choice",
        instructions: "Strongest emotion on the face?",
        criteria: { joy: null, surprise: null, anger: null, sadness: null, fear: null, disgust: null, neutral: null },
      },
      intensity: {
        type: "score",
        instructions: "How intense is the expression?",
        criteria: ["blank", "subtle", "clear", "exaggerated"],
      },
      mouth_open: { type: "noul", instructions: "Is the mouth open?" },
    },
  },
  {
    id: "objects",
    name: "Desk objects",
    blurb: "Yes/no checks for things people keep near a webcam.",
    state: "A live frame of a desk and the person at it.",
    questions: {
      mug: { type: "noul", instructions: "Is a mug or cup visible?" },
      glasses: { type: "noul", instructions: "Is the person wearing glasses?" },
      headphones: { type: "noul", instructions: "Is the person wearing headphones or earbuds?" },
      phone: { type: "noul", instructions: "Is a phone visible?" },
      paper: { type: "noul", instructions: "Is a book, notebook or paper visible?" },
      plant: { type: "noul", instructions: "Is a plant visible?" },
    },
  },
  {
    id: "camera",
    name: "Camera & room",
    blurb: "Lighting, sharpness, framing and the kind of place.",
    state: "A live webcam frame.",
    questions: {
      lighting: {
        type: "score",
        instructions: "How well lit is the scene?",
        criteria: ["very dark", "dim", "good", "very bright or overexposed"],
      },
      blurry: { type: "noul", instructions: "Is the image blurry?" },
      backlit: { type: "noul", instructions: "Is there a bright light or window behind the person?" },
      place: {
        type: "choice",
        instructions: "Where is this?",
        criteria: { home_office: null, bedroom: null, living_room: null, office: null, cafe: null, car: null, outdoors: null },
      },
      framing: {
        type: "choice",
        instructions: "How is the person framed?",
        criteria: { centered: null, off_center: null, too_close: null, partly_out_of_frame: null, no_person: null },
      },
    },
  },
  {
    id: "pets",
    name: "Pet cam",
    blurb: "Which animal is in view and what it is up to.",
    state: "A live frame from a camera watching a room.",
    questions: {
      animal: {
        type: "choice",
        instructions: "Which animal is visible?",
        criteria: { none: null, dog: null, cat: null, bird: null, other_animal: null },
      },
      animal_activity: {
        type: "choice",
        instructions: "What is the animal doing?",
        criteria: { sleeping: null, eating: null, playing: null, watching_camera: null, walking: null, no_animal: null },
      },
      on_furniture: { type: "noul", instructions: "Is an animal on a bed, sofa or table?" },
    },
  },
  {
    id: "safety",
    name: "Workspace safety",
    blurb: "People count, visible hands, and hazards in view.",
    state: "A live frame of a workspace.",
    questions: {
      people: {
        type: "score",
        instructions: "How many people are visible?",
        criteria: ["none", "one", "two", "three or more"],
      },
      hands_visible: { type: "noul", instructions: "Are both of the person's hands visible?" },
      hazard: {
        type: "choice",
        instructions: "Most serious hazard visible?",
        criteria: { none: null, open_flame: null, sharp_tool: null, spilled_liquid: null, loose_cables: null, blocked_exit: null },
      },
    },
  },
  {
    id: "support",
    name: "Support triage (text)",
    blurb: "A text state instead of an image: route and rate a message.",
    source: "text",
    state: "Checkout has thrown a 500 for every customer since 9am and we are losing orders. Please help ASAP.",
    questions: {
      team: {
        type: "choice",
        instructions: "Which team should handle this?",
        criteria: { billing: "payments, invoices, refunds", technical: "outages, errors, configuration", sales: "plans and upgrades", account: "login and access" },
      },
      severity: {
        type: "score",
        instructions: "How severe is the customer impact?",
        criteria: ["no impact", "minor", "major", "critical"],
      },
      urgent: { type: "noul", instructions: "Does the message ask for an urgent response?" },
      sentiment: {
        type: "choice",
        instructions: "Tone of the message?",
        criteria: { calm: null, worried: null, frustrated: null, angry: null },
      },
    },
  },
];

export const DEFAULT_PRESET = PRESETS[0];

export const clone = (value) => JSON.parse(JSON.stringify(value));
