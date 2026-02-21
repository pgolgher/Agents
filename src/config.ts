import dotenv from "dotenv";

dotenv.config();

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  model: "claude-haiku-4-5" as const,
};

if (!config.anthropicApiKey) {
  throw new Error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
}
