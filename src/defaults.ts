export type DefaultsType = {
  LAUNCHER_NAME: string;
  BACKEND_URL: string;
  DISCORD_LINK: string;
  LOGO_URL: string;
  BACKGROUND_URL: string;
  PLACEHOLDER_IMAGE: string;
  LAUNCHER_VERSION: string;
  ENABLE_API: boolean;
  UPDATER_CONFIGURED: boolean;
  PAKS_AND_SIGS_LINKS: string;
};

const env = import.meta.env;

export const Defaults: DefaultsType = {
  LAUNCHER_NAME: env.VITE_LAUNCHER_NAME || "Project Fishk",
  BACKEND_URL: env.VITE_BACKEND_URL || "http://127.0.0.1:3551",
  DISCORD_LINK: env.VITE_DISCORD_LINK || "https://example.com",
  LOGO_URL: env.VITE_LOGO_URL || "/Images/logo.png",
  BACKGROUND_URL: env.VITE_BACKGROUND_URL || "/Images/build-placeholder.webp",
  PLACEHOLDER_IMAGE: env.VITE_PLACEHOLDER_IMAGE || "/Images/build-placeholder.webp",
  LAUNCHER_VERSION: env.VITE_LAUNCHER_VERSION || "1.0.0",
  ENABLE_API: env.VITE_ENABLE_API === "true",
  UPDATER_CONFIGURED: env.VITE_UPDATER_CONFIGURED === "true",
  PAKS_AND_SIGS_LINKS: env.VITE_PAKS_AND_SIGS_LINKS || ""
};

export const LibraryConfig = {
  KEY: "storage:library",
};