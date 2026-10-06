// Progress of one palette answer while the AI works: a tool it called, or answer text as it arrives.
export type ChatEvent = { type: "tool"; name: string } | { type: "text"; text: string };
