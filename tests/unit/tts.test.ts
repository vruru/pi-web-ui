/**
 * tts.ts 单测（node 环境：localStorage / speechSynthesis 全部打桩）。
 * 覆盖：markdown 朗读净化、回复正文提取、设置持久化与越界矫正、
 * 语音选择解析、speak/stopSpeaking 与全局 speaking 状态跟踪。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_TTS_SETTINGS,
	MAX_TTS_CHARS,
	assistantPlainText,
	isSpeaking,
	isTtsAvailable,
	loadTtsSettings,
	onSpeakingChange,
	resolveVoice,
	speakingSourceId,
	speak,
	stopSpeaking,
	stripMarkdownForSpeech,
	type TtsSettings,
} from "../../web/src/tts.js";

// ---------------------------------------------------------------------------
// stubs
// ---------------------------------------------------------------------------

function stubLocalStorage(): void {
	const store = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
		setItem: (k: string, v: string) => {
			store.set(k, v);
		},
		removeItem: (k: string) => {
			store.delete(k);
		},
		clear: () => {
			store.clear();
		},
	});
}

type FakeUtterance = {
	text: string;
	rate: number;
	voice: unknown;
	onend: (() => void) | null;
	onerror: (() => void) | null;
};

const spoken: FakeUtterance[] = [];

function stubSpeechSynthesis(voices: { voiceURI: string; lang: string; name?: string }[] = []): void {
	spoken.length = 0;
	const synth = {
		cancel: vi.fn(),
		speak: vi.fn((u: FakeUtterance) => {
			spoken.push(u);
		}),
		getVoices: vi.fn(() => voices),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	};
	vi.stubGlobal("speechSynthesis", synth);
	vi.stubGlobal("window", { speechSynthesis: synth });
	vi.stubGlobal(
		"SpeechSynthesisUtterance",
		class {
			text: string;
			rate = 1;
			voice: unknown = null;
			onend: (() => void) | null = null;
			onerror: (() => void) | null = null;
			constructor(text: string) {
				this.text = text;
			}
		},
	);
}

beforeEach(() => {
	stubLocalStorage();
});

afterEach(() => {
	vi.unstubAllGlobals();
	stopSpeaking();
});

// ---------------------------------------------------------------------------
// stripMarkdownForSpeech
// ---------------------------------------------------------------------------

describe("stripMarkdownForSpeech", () => {
	it("drops fenced code blocks entirely and keeps surrounding prose", () => {
		const out = stripMarkdownForSpeech("before\n```js\nconst x = 1;\n```\nafter");
		expect(out).toBe("before after");
	});

	it("drops an unterminated fenced code block too", () => {
		const out = stripMarkdownForSpeech("prose\n```\nnever closed");
		expect(out).toBe("prose");
	});

	it("keeps inline code content but drops backticks", () => {
		expect(stripMarkdownForSpeech("run `npm ci` now")).toBe("run npm ci now");
	});

	it("collapses links to their text and drops images", () => {
		expect(stripMarkdownForSpeech("see [docs](https://x.y) and ![pic](a.png)")).toBe("see docs and");
	});

	it("strips headings, emphasis, blockquotes and list bullets", () => {
		const md = "## Title\n**bold** and *it* and _u_\n> quoted\n- item one\n* item two";
		const out = stripMarkdownForSpeech(md);
		expect(out).not.toContain("#");
		expect(out).toContain("Title");
		expect(out).toContain("bold");
		expect(out).not.toContain("**");
		expect(out).toContain("quoted");
		expect(out).toContain("item one");
		expect(out).not.toContain("-");
	});

	it("drops table separator rows and pipes", () => {
		const out = stripMarkdownForSpeech("| a | b |\n|---|---|\n| 1 | 2 |");
		expect(out).not.toContain("|");
		expect(out).not.toContain("---");
		expect(out).toContain("a");
		expect(out).toContain("1");
	});

	it("caps output at MAX_TTS_CHARS with an ellipsis", () => {
		const long = "字".repeat(MAX_TTS_CHARS + 100);
		const out = stripMarkdownForSpeech(long);
		expect(out.length).toBe(MAX_TTS_CHARS + 1); // + ellipsis
		expect(out.endsWith("…")).toBe(true);
	});

	it("returns empty string for empty input", () => {
		expect(stripMarkdownForSpeech("")).toBe("");
		expect(stripMarkdownForSpeech("```js\n```\n")).toBe("");
	});
});

// ---------------------------------------------------------------------------
// assistantPlainText
// ---------------------------------------------------------------------------

describe("assistantPlainText", () => {
	it("takes the LAST assistant message and only its text blocks", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "text", text: "first" }] },
			{ role: "user", content: [{ type: "text", text: "question" }] },
			{
				role: "assistant",
				content: [
					{ type: "thinking", text: "secret reasoning" },
					{ type: "text", text: "final **answer**" },
				],
			},
		];
		expect(assistantPlainText(msgs)).toBe("final answer");
	});

	it("returns empty for no messages / no assistant message", () => {
		expect(assistantPlainText(undefined)).toBe("");
		expect(assistantPlainText(null)).toBe("");
		expect(assistantPlainText([{ role: "user", content: [{ type: "text", text: "hi" }] }])).toBe("");
	});

	it("strips markdown from the reply", () => {
		const msgs = [{ role: "assistant", content: [{ type: "text", text: "# Title\n```\ncode\n```\ndone" }] }];
		expect(assistantPlainText(msgs)).toBe("Title done");
	});
});

// ---------------------------------------------------------------------------
// settings persistence
// ---------------------------------------------------------------------------

describe("tts settings persistence", () => {
	it("returns defaults when nothing is stored", () => {
		expect(loadTtsSettings()).toEqual(DEFAULT_TTS_SETTINGS);
	});

	it("returns defaults on corrupted JSON", () => {
		localStorage.setItem("pi-web-tts", "{not json");
		expect(loadTtsSettings()).toEqual(DEFAULT_TTS_SETTINGS);
	});

	it("sanitizes out-of-range and wrong-typed values", () => {
		localStorage.setItem("pi-web-tts", JSON.stringify({ enabled: "yes", rate: 99, voiceURI: 42, announce: false }));
		const s = loadTtsSettings();
		expect(s.enabled).toBe(DEFAULT_TTS_SETTINGS.enabled); // wrong type → default
		expect(s.rate).toBe(2); // clamped
		expect(s.voiceURI).toBe(""); // wrong type → default
		expect(s.announce).toBe(false); // valid override kept
	});

	it("round-trips through saveTtsSettings", () => {
		const s: TtsSettings = { enabled: true, announce: true, readReplies: true, rate: 1.3, voiceURI: "v1" };
		localStorage.setItem("pi-web-tts", JSON.stringify(s));
		expect(loadTtsSettings()).toEqual(s);
	});
});

// ---------------------------------------------------------------------------
// resolveVoice
// ---------------------------------------------------------------------------

describe("resolveVoice", () => {
	const voices = [
		{ voiceURI: "zh-voice", lang: "zh-CN" },
		{ voiceURI: "en-voice", lang: "en-US" },
	];

	it("prefers an exact URI match", () => {
		expect(resolveVoice("en-voice", voices, "zh-CN")?.voiceURI).toBe("en-voice");
	});

	it("falls back to a page-language prefix match when the URI is gone", () => {
		expect(resolveVoice("vanished", voices, "zh-CN")?.voiceURI).toBe("zh-voice");
		expect(resolveVoice("vanished", voices, "en-GB")?.voiceURI).toBe("en-voice");
	});

	it("returns null with no voices and no explicit URI", () => {
		expect(resolveVoice("", [], "zh-CN")).toBeNull();
		expect(resolveVoice("vanished", [], "zh-CN")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// speak / stopSpeaking / speaking state
// ---------------------------------------------------------------------------

describe("speak and speaking state", () => {
	it("reports availability only when window.speechSynthesis exists", () => {
		stubSpeechSynthesis();
		expect(isTtsAvailable()).toBe(true);
		vi.stubGlobal("window", {});
		expect(isTtsAvailable()).toBe(false);
	});

	it("speaks with rate and resolved voice, ignoring the enabled gate (manual intent)", () => {
		stubSpeechSynthesis([{ voiceURI: "zh-voice", lang: "zh-CN" }]);
		speak("你好", { ...DEFAULT_TTS_SETTINGS, enabled: false, rate: 1.5, voiceURI: "zh-voice" });
		expect(spoken).toHaveLength(1);
		expect(spoken[0]!.text).toBe("你好");
		expect(spoken[0]!.rate).toBe(1.5);
		expect(spoken[0]!.voice).toMatchObject({ voiceURI: "zh-voice" });
	});

	it("skips empty text and unavailable environments", () => {
		stubSpeechSynthesis();
		speak("", DEFAULT_TTS_SETTINGS);
		expect(spoken).toHaveLength(0);
		vi.stubGlobal("window", {});
		speak("hi", DEFAULT_TTS_SETTINGS);
		expect(spoken).toHaveLength(0);
	});

	it("tracks speaking state and source id, cleared on end", () => {
		stubSpeechSynthesis();
		const events: boolean[] = [];
		onSpeakingChange((s) => events.push(s));

		speak("line", DEFAULT_TTS_SETTINGS, "msg-1");
		expect(isSpeaking()).toBe(true);
		expect(speakingSourceId()).toBe("msg-1");

		spoken[0]!.onend?.();
		expect(isSpeaking()).toBe(false);
		expect(speakingSourceId()).toBeNull();
		expect(events).toEqual([true, false]);
	});

	it("stopSpeaking cancels and clears the state", () => {
		stubSpeechSynthesis();
		speak("line", DEFAULT_TTS_SETTINGS, "msg-2");
		stopSpeaking();
		expect(isSpeaking()).toBe(false);
		const synth = (window as unknown as { speechSynthesis: { cancel: ReturnType<typeof vi.fn> } }).speechSynthesis;
		expect(synth.cancel).toHaveBeenCalled();
	});

	it("a new speak call cancels the previous utterance", () => {
		stubSpeechSynthesis();
		speak("first", DEFAULT_TTS_SETTINGS, "a");
		speak("second", DEFAULT_TTS_SETTINGS, "b");
		const synth = (window as unknown as { speechSynthesis: { cancel: ReturnType<typeof vi.fn> } }).speechSynthesis;
		expect(synth.cancel).toHaveBeenCalled();
		expect(spoken).toHaveLength(2);
		expect(spoken[1]!.text).toBe("second");
		expect(speakingSourceId()).toBe("b");
	});
});
