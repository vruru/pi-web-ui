/**
 * Local text-to-speech announcements for pi-web-ui.
 *
 * Uses the browser's built-in SpeechSynthesis API only — no cloud keys, no
 * bundled models, nothing to install. Same persistence and opt-in philosophy
 * as sounds.ts: settings live in localStorage and the whole feature is off
 * until the user enables it in Settings → Sound & Voice.
 *
 * Two independent knobs (see TtsSettings):
 *  - announce:     speak a short canned line for cue events (turn finished /
 *                  waiting for input / error / tool approval), mirroring the
 *                  sound + desktop-notification channels.
 *  - readReplies:  when a turn finishes, speak the assistant's final reply
 *                  (markdown stripped, length-capped) instead of the canned
 *                  "finished" line.
 *
 * Like notify(), speech only fires while the user is NOT watching the page —
 * callers gate on shouldSuppressNotify() so the three channels (cue sound,
 * desktop toast, voice) never all fire at once while someone is reading.
 */

export interface TtsSettings {
	/** Master switch for AUTOMATIC announcements (opt-in, default off). The
	 * message toolbar's manual read-aloud button ignores this on purpose:
	 * an explicit click is its own intent. */
	enabled: boolean;
	/** Speak short canned lines for cue events (finished / input / error / approval). */
	announce: boolean;
	/** On turn finish, read the assistant's final reply instead of the canned line. */
	readReplies: boolean;
	/** Speech rate 0.5–2 (1 = normal). */
	rate: number;
	/** Preferred voice URI; empty = auto-pick a voice matching the page language. */
	voiceURI: string;
}

const STORAGE_KEY = "pi-web-tts";

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
	enabled: false,
	announce: true,
	readReplies: false,
	rate: 1,
	voiceURI: "",
};

/** Upper bound for spoken replies — nobody wants a 5-minute monologue. */
export const MAX_TTS_CHARS = 600;

/** Read persisted settings, falling back to defaults on any failure. */
export function loadTtsSettings(): TtsSettings {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULT_TTS_SETTINGS };
		const merged: TtsSettings = { ...DEFAULT_TTS_SETTINGS, ...(JSON.parse(raw) as Partial<TtsSettings>) };
		// Sanitize stored values so a corrupted or out-of-range entry can't
		// break the slider or make speech unintelligible.
		for (const k of ["enabled", "announce", "readReplies"] as const) {
			if (typeof merged[k] !== "boolean") merged[k] = DEFAULT_TTS_SETTINGS[k];
		}
		if (typeof merged.rate !== "number" || !Number.isFinite(merged.rate)) {
			merged.rate = DEFAULT_TTS_SETTINGS.rate;
		} else {
			merged.rate = Math.round(Math.max(0.5, Math.min(2, merged.rate)) * 10) / 10;
		}
		if (typeof merged.voiceURI !== "string") merged.voiceURI = DEFAULT_TTS_SETTINGS.voiceURI;
		return merged;
	} catch {
		return { ...DEFAULT_TTS_SETTINGS };
	}
}

export function saveTtsSettings(settings: TtsSettings): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	} catch {
		// storage unavailable (private mode etc.) — settings just won't persist
	}
}

/** True when the browser exposes SpeechSynthesis at all. */
export function isTtsAvailable(): boolean {
	return typeof window !== "undefined" && "speechSynthesis" in window;
}

/**
 * Pick the utterance voice: exact URI match first, then first voice whose
 * lang matches the page language prefix, else null (browser default voice).
 * Pure so settings UI and tests can reuse it; `voices` may be empty — Chrome
 * populates getVoices() asynchronously and an empty list just means default.
 */
export function resolveVoice(
	voiceURI: string,
	voices: { voiceURI: string; lang: string }[],
	pageLang: string,
): { voiceURI: string; lang: string } | null {
	if (voiceURI) {
		const exact = voices.find((v) => v.voiceURI === voiceURI);
		if (exact) return exact;
	}
	const prefix = pageLang.split("-")[0]?.toLowerCase();
	if (!prefix) return null;
	return voices.find((v) => v.lang.toLowerCase().startsWith(prefix)) ?? null;
}

/**
 * Strip markdown down to something pleasant to listen to: code blocks and
 * images are dropped entirely, links collapse to their text, and heading /
 * emphasis / table / quote syntax is removed. Pure.
 */
export function stripMarkdownForSpeech(input: string): string {
	let text = input ?? "";
	text = text.replace(/```[\s\S]*?(?:```|$)/g, " "); // fenced code (also unterminated)
	text = text.replace(/`([^`]+)`/g, "$1"); // inline code → its content
	text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " "); // images
	text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // links → text
	text = text.replace(/^\s{0,3}#{1,6}\s+/gm, ""); // headings
	text = text.replace(/^\s{0,3}>\s?/gm, ""); // blockquotes
	text = text.replace(/^\s*[-*+]\s+/gm, ""); // unordered bullets
	text = text.replace(/^\s*\|?[\s:|-]*\|[\s:|-]*$/gm, ""); // table separator rows
	text = text.replace(/\|/g, " "); // remaining table pipes
	text = text.replace(/(\*\*\*|\*\*|__)(.*?)\1/g, "$2"); // bold
	text = text.replace(/(\*|_)([^*_\n]+)\1/g, "$2"); // italic
	text = text.replace(/<[^>]+>/g, " "); // stray html tags
	text = text.replace(/\r/g, "");
	text = text.replace(/[ \t]+/g, " ");
	text = text.replace(/\s*\n+\s*/g, " "); // spoken text is one breath flow — newlines become spaces
	text = text.trim();
	if (text.length > MAX_TTS_CHARS) text = `${text.slice(0, MAX_TTS_CHARS).trimEnd()}…`;
	return text;
}

/** Minimal message shape (subset of UiMessage) so tests stay framework-free. */
export interface SpeechLikeMessage {
	role: string;
	content: { type?: string; text?: string }[];
}

/**
 * Plain text of the LAST assistant message: concatenated text blocks with
 * markdown stripped. Thinking/tool blocks and other roles are skipped.
 * Returns "" when there is nothing speakable. Pure.
 */
export function assistantPlainText(messages: SpeechLikeMessage[] | undefined | null): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m || m.role !== "assistant") continue;
		const text = (m.content ?? [])
			.filter((b) => (b as { type?: string })?.type === "text" && typeof b.text === "string")
			.map((b) => b.text ?? "")
			.join("\n");
		return stripMarkdownForSpeech(text);
	}
	return "";
}

/**
 * Global speaking state with a tiny subscription — the message toolbar's
 * per-message "read aloud / stop" button toggles on it. speechSynthesis is a
 * browser-wide singleton, so the state lives here, not per component.
 */
let speakingActive = false;
let speakingSource: string | null = null;
// 最近一次真正提交给 synth.speak 的词条。被 cancel 的旧词条其 onend/onerror 在多数
// 浏览器是异步触发的，可能晚于新词条开播 —— 用引用比对守卫，避免旧词条的回调把
// 新词条的 speaking 标志误清（按钮态错乱、isSpeaking 失真）。
let speakingUtter: SpeechSynthesisUtterance | null = null;
const speakingListeners = new Set<(speaking: boolean) => void>();

function setSpeaking(active: boolean, source: string | null = null): void {
	if (active) {
		speakingActive = true;
		speakingSource = source;
	} else {
		speakingActive = false;
		speakingSource = null;
	}
	for (const cb of speakingListeners) {
		try {
			cb(active);
		} catch {
			// a broken listener must not break the others
		}
	}
}

/** True while an utterance started by this module is (probably) still playing. */
export function isSpeaking(): boolean {
	return speakingActive;
}

/** Caller-chosen id of the utterance in flight (message id on the toolbar), else null. */
export function speakingSourceId(): string | null {
	return speakingActive ? speakingSource : null;
}

/** Subscribe to speaking-state changes; returns an unsubscribe function. */
export function onSpeakingChange(cb: (speaking: boolean) => void): () => void {
	speakingListeners.add(cb);
	return () => speakingListeners.delete(cb);
}

/**
 * Speak `text` (any settings/availability failures silently no-op, mirroring
 * playSound's pre-gesture behaviour). Cancels any in-flight utterance first
 * so overlapping cues can't stack into an unintelligible queue. `sourceId`
 * tags the utterance so per-message buttons know whether THEY are speaking.
 */
export function speak(text: string, settings: TtsSettings = loadTtsSettings(), sourceId?: string): void {
	if (!text) return;
	if (!isTtsAvailable()) return;
	try {
		const synth = window.speechSynthesis;
		synth.cancel();
		const utter = new SpeechSynthesisUtterance(text);
		utter.rate = settings.rate;
		const voice = resolveVoice(settings.voiceURI, synth.getVoices(), navigator.language);
		if (voice) utter.voice = voice as SpeechSynthesisVoice;
		// End/error paths both clear the flag; onerror is intentionally silent:
		// a blocked/failed voice must never surface as an error notice — speech
		// is a best-effort channel. Both are guarded by the utterance reference:
		// a cancelled predecessor's async callback must not clear the successor's
		// speaking state.
		utter.onend = () => {
			if (speakingUtter === utter) setSpeaking(false);
		};
		utter.onerror = () => {
			if (speakingUtter === utter) setSpeaking(false);
		};
		speakingUtter = utter;
		setSpeaking(true, sourceId ?? null);
		synth.speak(utter);
	} catch {
		speakingUtter = null;
		setSpeaking(false);
	}
}

/** Stop any in-flight speech (tab switch, dialog open, …). */
export function stopSpeaking(): void {
	if (!isTtsAvailable()) return;
	try {
		window.speechSynthesis.cancel();
	} catch {
		// ignore
	}
	// 主动取消后清引用：旧词条迟到的 onend 不会也无需再动 speaking 状态。
	speakingUtter = null;
	setSpeaking(false);
}
