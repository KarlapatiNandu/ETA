import { createContext, useContext } from "react";

/**
 * The driver app in the drivers' languages (Stage 9: "translate the driver app before the pilot",
 * carried from Stage 2). Everything a driver sees on a trip is here; the route-survey tab is used
 * by the Transport Department's surveyor and stays in English.
 *
 * ⚠️ The Telugu and Hindi strings are a first draft: a native speaker at the Transport Department
 * must review them before the pilot (M09 carried forward). The big START / END buttons keep the
 * English word in brackets so they match the printed driver sheet.
 */

export type Lang = "en" | "te" | "hi";
export const LANGS: { code: Lang; label: string }[] = [
  { code: "en", label: "EN" },
  { code: "te", label: "తెలుగు" },
  { code: "hi", label: "हिन्दी" },
];

const en = {
  starting: "Starting…",
  pairTitle: "Pair this phone",
  pairHelp: "Open the pairing link from the Transport Department on this phone, or paste it here.",
  pairButton: "PAIR",
  notAPairingLink: "That is not a pairing link.",
  network: "Network",
  noNetwork: "No network — buffering",
  gpsWaiting: "GPS: waiting",
  gps: (acc: number) => `GPS ±${acc} m`,
  wake: {
    off: "Screen lock: off",
    held: "Screen stays on",
    released: "Screen lock lost — reopen the app",
    unsupported: "Keep the screen on manually",
    error: "Screen lock refused (battery saver?)",
  },
  cannotReach: "Cannot reach the server. Trips you start will buffer until it is back.",
  clockWrong: "This phone's clock is wrong. Set date & time to automatic, then reopen the app.",
  unpaired: "This phone is not paired any more. Ask the transport office for a new link.",
  serverAnswered: (status: number) => `The server answered ${status}. Try again shortly.`,
  tabTrip: "Trip",
  tabSurvey: "Route survey",
  endBeforeUnpair: "End the trip before un-pairing.",
  confirmUnpair: "Remove this phone's pairing? You will need a new link from the transport office.",
  device: (uid: string) => `Device ${uid} · un-pair`,
  onTrip: "ON TRIP",
  endingTrip: "ENDING TRIP…",
  pingsSent: "pings sent",
  waitingToSend: "waiting to send",
  lastSent: (ago: string, cadence: number) => `Last sent ${ago} · reporting every ${cadence} s`,
  never: "never",
  secondsAgo: (s: number) => `${s} s ago`,
  minutesAgo: (m: number) => `${m} min ago`,
  sendingLast: (n: number) => `Sending the last ${n} buffered pings, then the trip closes.`,
  confirmEnd: "End this trip?",
  endTrip: "END TRIP",
  loadingRoutes: "Loading routes…",
  notAssigned: "This phone is not assigned to a bus yet.",
  chooseRoute: "Choose today's route",
  toCampus: "to campus",
  fromCampus: "from campus",
  noRoutes: "No published routes yet.",
  mount: "Mount the phone, plug in the charger, keep this screen open.",
  startTrip: "START TRIP",
  endBeforeSurvey: "End the trip before surveying a route.",
};

export type Strings = typeof en;

const te: Strings = {
  starting: "ప్రారంభమవుతోంది…",
  pairTitle: "ఈ ఫోన్‌ను జత చేయండి",
  pairHelp: "రవాణా విభాగం పంపిన జత లింక్‌ను ఈ ఫోన్‌లో తెరవండి, లేదా ఇక్కడ అతికించండి.",
  pairButton: "జత చేయండి",
  notAPairingLink: "ఇది జత చేసే లింక్ కాదు.",
  network: "నెట్‌వర్క్ ఉంది",
  noNetwork: "నెట్‌వర్క్ లేదు — దాచి ఉంచుతోంది",
  gpsWaiting: "GPS: వేచి ఉంది",
  gps: (acc) => `GPS ±${acc} మీ`,
  wake: {
    off: "స్క్రీన్ లాక్: ఆఫ్",
    held: "స్క్రీన్ ఆన్‌లోనే ఉంటుంది",
    released: "స్క్రీన్ లాక్ పోయింది — యాప్‌ను మళ్లీ తెరవండి",
    unsupported: "స్క్రీన్‌ను మీరే ఆన్‌లో ఉంచండి",
    error: "స్క్రీన్ లాక్ రాలేదు (బ్యాటరీ సేవర్?)",
  },
  cannotReach:
    "సర్వర్ అందుబాటులో లేదు. మీరు ప్రారంభించే ట్రిప్‌లు అది తిరిగి వచ్చే వరకు దాచి ఉంచబడతాయి.",
  clockWrong:
    "ఈ ఫోన్ గడియారం తప్పుగా ఉంది. తేదీ & సమయాన్ని ఆటోమేటిక్‌గా పెట్టి, యాప్‌ను మళ్లీ తెరవండి.",
  unpaired: "ఈ ఫోన్ ఇప్పుడు జత కాలేదు. రవాణా కార్యాలయం నుండి కొత్త లింక్ అడగండి.",
  serverAnswered: (status) =>
    `సర్వర్ ${status} అని జవాబిచ్చింది. కొద్దిసేపటి తర్వాత ప్రయత్నించండి.`,
  tabTrip: "ట్రిప్",
  tabSurvey: "రూట్ సర్వే",
  endBeforeUnpair: "జత తీసే ముందు ట్రిప్ ముగించండి.",
  confirmUnpair: "ఈ ఫోన్ జత తీసివేయాలా? రవాణా కార్యాలయం నుండి కొత్త లింక్ కావాలి.",
  device: (uid) => `పరికరం ${uid} · జత తీయండి`,
  onTrip: "ట్రిప్‌లో ఉంది",
  endingTrip: "ట్రిప్ ముగుస్తోంది…",
  pingsSent: "పంపినవి",
  waitingToSend: "పంపడానికి మిగిలినవి",
  lastSent: (ago, cadence) => `చివరిగా పంపింది ${ago} · ప్రతి ${cadence} సెకన్లకు`,
  never: "ఇంకా లేదు",
  secondsAgo: (s) => `${s} సె. క్రితం`,
  minutesAgo: (m) => `${m} ని. క్రితం`,
  sendingLast: (n) => `మిగిలిన ${n} పంపుతోంది, తర్వాత ట్రిప్ ముగుస్తుంది.`,
  confirmEnd: "ఈ ట్రిప్ ముగించాలా?",
  endTrip: "ట్రిప్ ముగించు (END TRIP)",
  loadingRoutes: "రూట్లు వస్తున్నాయి…",
  notAssigned: "ఈ ఫోన్‌ను ఇంకా ఏ బస్సుకూ ఇవ్వలేదు.",
  chooseRoute: "ఈరోజు రూట్ ఎంచుకోండి",
  toCampus: "క్యాంపస్‌కు",
  fromCampus: "క్యాంపస్ నుండి",
  noRoutes: "ఇంకా రూట్లు ప్రచురించలేదు.",
  mount: "ఫోన్‌ను పెట్టండి, చార్జర్ పెట్టండి, ఈ స్క్రీన్‌ను తెరిచే ఉంచండి.",
  startTrip: "ట్రిప్ ప్రారంభించు (START TRIP)",
  endBeforeSurvey: "రూట్ సర్వే చేసే ముందు ట్రిప్ ముగించండి.",
};

const hi: Strings = {
  starting: "शुरू हो रहा है…",
  pairTitle: "इस फ़ोन को जोड़ें",
  pairHelp: "परिवहन विभाग से मिला जोड़ने वाला लिंक इस फ़ोन पर खोलें, या यहाँ चिपकाएँ।",
  pairButton: "जोड़ें",
  notAPairingLink: "यह जोड़ने वाला लिंक नहीं है।",
  network: "नेटवर्क है",
  noNetwork: "नेटवर्क नहीं — सहेजा जा रहा है",
  gpsWaiting: "GPS: प्रतीक्षा",
  gps: (acc) => `GPS ±${acc} मी`,
  wake: {
    off: "स्क्रीन लॉक: बंद",
    held: "स्क्रीन चालू रहेगी",
    released: "स्क्रीन लॉक छूट गया — ऐप फिर खोलें",
    unsupported: "स्क्रीन ख़ुद चालू रखें",
    error: "स्क्रीन लॉक नहीं मिला (बैटरी सेवर?)",
  },
  cannotReach:
    "सर्वर तक नहीं पहुँच पा रहे। आप जो ट्रिप शुरू करेंगे, वह सर्वर लौटने तक सहेजी जाएगी।",
  clockWrong: "इस फ़ोन की घड़ी ग़लत है। तारीख़ और समय स्वचालित करें, फिर ऐप दोबारा खोलें।",
  unpaired: "यह फ़ोन अब जुड़ा नहीं है। परिवहन कार्यालय से नया लिंक माँगें।",
  serverAnswered: (status) => `सर्वर ने ${status} लौटाया। थोड़ी देर बाद कोशिश करें।`,
  tabTrip: "ट्रिप",
  tabSurvey: "रूट सर्वे",
  endBeforeUnpair: "हटाने से पहले ट्रिप समाप्त करें।",
  confirmUnpair: "इस फ़ोन का जुड़ाव हटाएँ? परिवहन कार्यालय से नया लिंक चाहिए होगा।",
  device: (uid) => `डिवाइस ${uid} · हटाएँ`,
  onTrip: "ट्रिप पर",
  endingTrip: "ट्रिप समाप्त हो रही है…",
  pingsSent: "भेजे गए",
  waitingToSend: "भेजने के लिए बाक़ी",
  lastSent: (ago, cadence) => `आख़िरी बार भेजा ${ago} · हर ${cadence} सेकंड`,
  never: "अभी नहीं",
  secondsAgo: (s) => `${s} से. पहले`,
  minutesAgo: (m) => `${m} मि. पहले`,
  sendingLast: (n) => `बाक़ी ${n} भेजे जा रहे हैं, फिर ट्रिप बंद होगी।`,
  confirmEnd: "यह ट्रिप समाप्त करें?",
  endTrip: "ट्रिप समाप्त करें (END TRIP)",
  loadingRoutes: "रूट आ रहे हैं…",
  notAssigned: "यह फ़ोन अभी किसी बस को नहीं दिया गया है।",
  chooseRoute: "आज का रूट चुनें",
  toCampus: "कैंपस की ओर",
  fromCampus: "कैंपस से",
  noRoutes: "अभी कोई रूट प्रकाशित नहीं है।",
  mount: "फ़ोन लगाएँ, चार्जर लगाएँ, यह स्क्रीन खुली रखें।",
  startTrip: "ट्रिप शुरू करें (START TRIP)",
  endBeforeSurvey: "रूट सर्वे से पहले ट्रिप समाप्त करें।",
};

export const STRINGS: Record<Lang, Strings> = { en, te, hi };

const KEY = "busmitra.driver.lang";

/** The saved choice, else the phone's language, else English. */
export function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "en" || saved === "te" || saved === "hi") return saved;
  } catch {
    // storage unavailable: fall through
  }
  const nav = typeof navigator !== "undefined" ? navigator.language.slice(0, 2) : "en";
  return nav === "te" || nav === "hi" ? nav : "en";
}

export function saveLang(lang: Lang) {
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    // not fatal: the choice lasts until the app closes
  }
}

export const LangContext = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({
  lang: "en",
  setLang: () => undefined,
});

export function useT(): Strings {
  return STRINGS[useContext(LangContext).lang];
}
