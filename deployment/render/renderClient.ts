import OpenAI from "openai";

let client: OpenAI | undefined;
// Configuration is lazy: viewing restored dashboards requires no AI key.
// The read-only HTTP guard also prevents new AI generation in this package.
export const openai = new Proxy({} as OpenAI, {
  get(_target, property) {
    if (!client) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("Independent OpenAI access is not configured for this Render copy.");
      client = new OpenAI({ apiKey, baseURL: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1" });
    }
    const value = Reflect.get(client, property, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
