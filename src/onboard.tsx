// src/onboard.tsx
import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { checkUpdate, installUpdate, type UpdateManifest } from "@tauri-apps/api/updater";
import { open } from "@tauri-apps/api/dialog";
import { readBinaryFile, exists } from "@tauri-apps/api/fs";
import { join } from "@tauri-apps/api/path";
import { useNavigate } from "react-router-dom";
import { fetch, ResponseType } from "@tauri-apps/api/http";
import { Defaults } from "./defaults";
import NewsPanel from "./NewsPanel";
import { appWindow } from "@tauri-apps/api/window";
import { listen } from '@tauri-apps/api/event';
import "./launcher.css";
import {
  Home,
  Grid,
  Settings,
  LogOut,
  Play,
  Plus,
  Trash2,
  Trophy,
  ShoppingCart,
  CloudDownload,
  Newspaper,
  Download,
  Server,
  FolderOpen,
  Eye,
  EyeOff,
  Minus,
  X
} from "lucide-react";
import "./App.css";

interface UserData {
  email: string;
  password?: string;
  username?: string;
  discordId?: string;
  avatarHash?: string | null;
  isAdmin?: boolean;
}

interface ArenaLeaderboardEntry {
  username: string;
  hype: number;
  division: number;
  discordId?: string;
  avatarHash?: string;
}

interface CosmeticInfo {
  id: string;
  name: string;
  description: string;
  image: string;
  rarity: string;
}

/* -------------------- Helpers -------------------- */
function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null as any, bytes.subarray(i, i + chunk) as any);
  }
  return btoa(binary);
}
function getFolderName(p: string) {
  const parts = p.split(/\\|\//).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function hasTauriRuntime() {
  return typeof window !== "undefined" && typeof (window as Window & { __TAURI_IPC__?: unknown }).__TAURI_IPC__ === "function";
}

/* -------------------- Types -------------------- */
type TabKey = "home" | "library" | "news" | "shop" | "settings" | "leaderboard";
type BuildItem = { id: string; path: string; name: string; version?: string; versionError?: string; coverDataUrl?: string };
type BuildDownloadProgress = {
  percent: number;
  downloadedBytes: number;
  totalBytes: number | null;
  bytesPerSecond: number;
  etaSeconds: number | null;
};
type UpdateTrackerStatus = "browser" | "setup" | "checking" | "current" | "available" | "installing" | "error";
type LauncherTheme = "midnight" | "ember" | "grove" | "rose";

const launcherThemes: { id: LauncherTheme; name: string; accent: string; colors: string[] }[] = [
  { id: "midnight", name: "Midnight", accent: "#78c9ff", colors: ["#101b2d", "#14323b", "#78c9ff"] },
  { id: "ember", name: "Ember", accent: "#ff986a", colors: ["#251612", "#43241c", "#ff986a"] },
  { id: "grove", name: "Grove", accent: "#91d69a", colors: ["#102019", "#1c3427", "#91d69a"] },
  { id: "rose", name: "Rose", accent: "#f0789a", colors: ["#24131d", "#421e31", "#f0789a"] },
];

function formatEta(seconds: number | null) {
  if (seconds === null) return "Calculating time remaining";
  if (seconds < 60) return `${seconds}s remaining`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s remaining`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m remaining`;
}

function formatTransferRate(bytesPerSecond: number) {
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  if (bytesPerSecond >= 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
  return `${bytesPerSecond} B/s`;
}

function formatBytes(bytes: number | null) {
  if (bytes === null) return "Unknown";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

const TabTransition: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="w-full">
    {children}
  </div>
);

const NavItem = ({ icon, label, id, active, setActive }: {
  icon: React.ReactNode;
  label: string;
  id: TabKey;
  active: TabKey;
  setActive: (value: TabKey) => void;
}) => (
  <button
    onClick={() => setActive(id)}
    data-active={active === id}
    className="launcher-nav-item cursor-pointer relative w-full flex items-center gap-3 px-4 py-3 rounded-md transition-all duration-200 group z-10"
  >
    <span className="launcher-nav-icon transition-colors">{icon}</span>
    <span className="text-sm font-medium">{label}</span>
  </button>
);

/* -------------------- Component -------------------- */
export default function Onboard() {
  const navigate = useNavigate();
  const [active, setActive] = useState<TabKey>("home");
  const [path, setPath] = useState<string | null>(null);
  const [isLaunching, setIsLaunching] = useState(false);
  const [isGameRunning, setIsGameRunning] = useState(false);
  const [isHostRunning, setIsHostRunning] = useState(false);
  const [isHostStarting, setIsHostStarting] = useState(false);
  const [hostStatus, setHostStatus] = useState("Host stopped");
  const [erbiumDllPath, setErbiumDllPath] = useState("");
  const [isClosingGame, setIsClosingGame] = useState(false);
  const [user, setUser] = useState<UserData | null>(null);
  const [builds, setBuilds] = useState<BuildItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [eor, setEor] = useState(() => localStorage.getItem("gameSetting.eor") === "true");
  const [ror, setRor] = useState(false);
  const [disablePreedits, setDisablePreedits] = useState(false);
  const [bubbleBuilds, setBubbleBuilds] = useState(() => localStorage.getItem("gameSetting.bubbleBuilds") === "true");
  const [isApplyingBubbleBuilds, setIsApplyingBubbleBuilds] = useState(false);
  const [stretchResolutionEnabled, setStretchResolutionEnabled] = useState(() => localStorage.getItem("gameSetting.stretchResolution") === "true");
  const [resolutionWidth, setResolutionWidth] = useState(() => Number(localStorage.getItem("gameSetting.resolutionWidth")) || 1600);
  const [resolutionHeight, setResolutionHeight] = useState(() => Number(localStorage.getItem("gameSetting.resolutionHeight")) || 1080);
  const [mobileBuilds, setMobileBuilds] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentStatus, setCurrentStatus] = useState("");
  const [warningMsg, setWarningMsg] = useState("");
  const [isBuildDownload, setIsBuildDownload] = useState(false);
  const [downloadEta, setDownloadEta] = useState<number | null>(null);
  const [downloadRate, setDownloadRate] = useState(0);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [downloadTotalBytes, setDownloadTotalBytes] = useState<number | null>(null);
  const [showDownloadDetails, setShowDownloadDetails] = useState(false);
  const [accentColor, setAccentColor] = useState(() => localStorage.getItem("launcherAccentColor") ?? "#78c9ff");
  const [theme, setTheme] = useState<LauncherTheme>(() => {
    const savedTheme = localStorage.getItem("launcherTheme");
    return launcherThemes.some((item) => item.id === savedTheme) ? savedTheme as LauncherTheme : "midnight";
  });
  const [heroVideoUnavailable, setHeroVideoUnavailable] = useState(false);
  const [updateTrackerStatus, setUpdateTrackerStatus] = useState<UpdateTrackerStatus>("browser");
  const [updateManifest, setUpdateManifest] = useState<UpdateManifest | null>(null);
  const [updateTrackerMessage, setUpdateTrackerMessage] = useState("Open the installed desktop launcher to check for updates.");
  const hasAutoCheckedUpdates = useRef(false);

  const checkForUpdates = async () => {
    if (!hasTauriRuntime()) {
      setUpdateTrackerStatus("browser");
      setUpdateTrackerMessage("Update checks are only available in the installed desktop launcher.");
      return;
    }
    if (!Defaults.UPDATER_CONFIGURED) {
      setUpdateTrackerStatus("setup");
      setUpdateTrackerMessage("Automatic updates are disabled for this launcher build.");
      return;
    }

    setUpdateTrackerStatus("checking");
    setUpdateTrackerMessage("Checking the signed GitHub release feed...");
    setUpdateManifest(null);
    try {
      const result = await checkUpdate();
      if (result.shouldUpdate && result.manifest) {
        setUpdateManifest(result.manifest);
        setUpdateTrackerStatus("available");
        setUpdateTrackerMessage(`Version ${result.manifest.version} is ready to install.`);
      } else {
        setUpdateTrackerStatus("current");
        setUpdateTrackerMessage(`You are on version ${Defaults.LAUNCHER_VERSION}.`);
      }
    } catch (updateError) {
      setUpdateTrackerStatus("error");
      setUpdateTrackerMessage(`Could not check updates. The GitHub release endpoint and signing key still need to be configured. ${String(updateError)}`);
    }
  };

  const installAvailableUpdate = async () => {
    if (!hasTauriRuntime() || !updateManifest) return;
    setUpdateTrackerStatus("installing");
    setUpdateTrackerMessage(`Downloading version ${updateManifest.version}...`);
    try {
      await installUpdate();
      setUpdateTrackerMessage("Update installed. The launcher will restart.");
    } catch (updateError) {
      setUpdateTrackerStatus("error");
      setUpdateTrackerMessage(`Update installation failed: ${String(updateError)}`);
    }
  };

  useEffect(() => {
    if (!hasTauriRuntime() || hasAutoCheckedUpdates.current) return;
    hasAutoCheckedUpdates.current = true;
    if (Defaults.UPDATER_CONFIGURED) {
      void checkForUpdates();
    } else {
      setUpdateTrackerStatus("setup");
      setUpdateTrackerMessage("Automatic updates are disabled for this launcher build.");
    }
  }, []);

useEffect(() => {
  const unlistenStart = listen('download-start', () => {
        setIsDownloading(true);
        setIsBuildDownload(false);
        setWarningMsg("");
        setShowDownloadDetails(false);
    });
  const unlistenProgress = listen<number>('download-progress', (e) => setProgress(e.payload));
  const unlistenStatus = listen<string>('update-status', (e) => setCurrentStatus(e.payload));
  const unlistenWarn = listen<string>('download-warning', (e) => {
        setWarningMsg(e.payload);
    });
  const unlistenDone = listen('download-complete', () => {
        setIsDownloading(false);
        setWarningMsg("");
    });
  const unlistenBuildStart = listen('build-download-start', () => {
    setIsDownloading(true);
    setIsBuildDownload(true);
    setProgress(0);
    setDownloadEta(null);
    setDownloadRate(0);
    setDownloadedBytes(0);
    setDownloadTotalBytes(null);
    setShowDownloadDetails(false);
    setCurrentStatus("Connecting to build host...");
    setWarningMsg("");
  });
  const unlistenBuildProgress = listen<BuildDownloadProgress>('build-download-progress', (event) => {
    setProgress(event.payload.percent);
    setDownloadEta(event.payload.etaSeconds);
    setDownloadRate(event.payload.bytesPerSecond);
    setDownloadedBytes(event.payload.downloadedBytes);
    setDownloadTotalBytes(event.payload.totalBytes);
  });
  const unlistenBuildComplete = listen<string>('build-download-complete', () => {
    setProgress(100);
    setCurrentStatus("Build installed");
    setIsDownloading(false);
  });
  const unlistenBuildError = listen<string>('build-download-error', (event) => {
    setWarningMsg(event.payload);
    setIsDownloading(false);
  });

  return () => {
    unlistenWarn.then(f => f());
    unlistenStart.then(f => f());
    unlistenProgress.then(f => f());
    unlistenStatus.then(f => f());
    unlistenDone.then(f => f());
    unlistenBuildStart.then(f => f());
    unlistenBuildProgress.then(f => f());
    unlistenBuildComplete.then(f => f());
    unlistenBuildError.then(f => f());
  };
}, []);

/* -------------------- Panels -------------------- */
const LeaderboardPanel: React.FC = () => {
  const [entries, setEntries] = useState<ArenaLeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchLeaderboard = async () => {
  if (!Defaults.ENABLE_API) {
    console.log("Leaderboard API is disabled via Defaults.");
    setEntries([]);
    setLoading(false);
    return;
  }

  try {
    const response = await fetch(`${Defaults.BACKEND_URL}/api/launcher/leaderboard`, {
      method: 'GET',
      responseType: ResponseType.JSON,
    });

    if (response.ok) {
      setEntries(response.data as ArenaLeaderboardEntry[]);
    }
  } catch (err) {
    console.error("Leaderboard Error:", err);
  } finally {
    setLoading(false);
  }
};

  useEffect(() => {
    fetchLeaderboard();

    const interval = setInterval(fetchLeaderboard, 600000);
    
    return () => clearInterval(interval);
  }, []);

  const getRankStyle = (index: number) => {
    if (index === 0) return { icon: "🥇", color: "text-yellow-400", bg: "bg-yellow-400/10", border: "border-yellow-400/20" };
    if (index === 1) return { icon: "🥈", color: "text-slate-300", bg: "bg-slate-300/10", border: "border-slate-300/20" };
    if (index === 2) return { icon: "🥉", color: "text-orange-500", bg: "bg-orange-500/10", border: "border-orange-500/20" };
    return { icon: `#${index + 1}`, color: "text-slate-500", bg: "bg-transparent", border: "border-transparent" };
  };

  return (
    <div className="max-w-5xl mx-auto">
      
      {/* Header Section */}
      <div className="flex items-center justify-between mb-6 px-1">
        <div>
          <div className="text-2xl font-black text-white uppercase tracking-tighter italic">Arena Leaderboard</div>
          <div className="text-[10px] text-slate-500 font-bold tracking-[0.2em] mt-0.5 uppercase opacity-80"></div>
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-[#0b1724]/60 backdrop-blur-xl overflow-hidden shadow-2xl">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-black/40 text-slate-500 text-[10px] uppercase tracking-[0.2em] border-b border-white/5">
              <th className="px-8 py-4 font-black">Rank</th>
              <th className="px-8 py-4 font-black">Player</th>
              <th className="px-8 py-4 font-black">Division</th>
              <th className="px-8 py-4 font-black text-right">Hype</th>
            </tr>
          </thead>
          
          <tbody className="divide-y divide-white/[0.03]">
            {loading ? (
              <tr>
                <td colSpan={4} className="px-8 py-32 text-center">
                  <div className="text-sm text-slate-400">Loading leaderboard...</div>
                </td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-4">
                  {/* Container: Matches Library/Shop py-24, border-white/20, and bg-white/[0.03] */}
                  <div className="py-24 border-2 border-dashed border-white/20 rounded-2xl bg-white/[0.03] flex flex-col items-center justify-center transition-colors hover:border-white/30">
                    
                    {/* Icon Container: Matches w-14/h-14, bg-white/10, and text-slate-300 */}
                    <div className="w-14 h-14 rounded-full bg-white/10 flex items-center justify-center mb-4 text-slate-300 shadow-inner">
                      <Trophy size={28} />
                    </div>
                    
                    {/* Title: Matches text-slate-300 text-sm font-medium */}
                    <p className="text-slate-300 text-sm font-medium">
                      Leaderboard Unavailable
                    </p>
                    
                    {/* Subtitle: Matches text-slate-500 text-xs mt-1 */}
                    <p className="text-slate-500 text-xs mt-1">
                      Arena rankings are currently being calculated or offline.
                    </p>
                  </div>
                </td>
              </tr>
            ) : (
              entries.map((player, index) => {
                const rank = getRankStyle(index);
                return (
                  <tr key={index} className="hover:bg-white/[0.01] transition-colors group">
                    {/* Rank */}
                    <td className="px-8 py-5">
                      <div className={`inline-flex items-center justify-center w-9 h-9 rounded-lg font-black text-xs ${rank.bg} ${rank.color} border ${rank.border}`}>
                        {rank.icon}
                      </div>
                    </td>

                    {/* Competitor */}
                    <td className="px-8 py-5">
                      <div className="flex items-center gap-4">
                        <div className="w-9 h-9 rounded-xl border border-white/10 overflow-hidden bg-[#071422] flex items-center justify-center shadow-lg">
                          {player.discordId && player.avatarHash ? (
                            <img 
                              src={`https://cdn.discordapp.com/avatars/${player.discordId}/${player.avatarHash}.png?size=64`} 
                              alt={player.username}
                              className="w-full h-full object-cover"
                              onError={(e) => { e.currentTarget.style.display = 'none'; }}
                            />
                          ) : (
                            <span className="text-xs font-black text-blue-400">{player.username[0]}</span>
                          )}
                        </div>
                        <span className="font-bold text-slate-200 group-hover:text-blue-400 transition-colors tracking-tight">
                          {player.username}
                        </span>
                      </div>
                    </td>

                    {/* Division - Just the number now */}
                    <td className="px-8 py-5">
                      <div className="flex items-center gap-2">
                         <span className="text-sm font-black text-slate-400 tracking-tighter italic">DIV</span>
                         <span className="text-lg font-black text-white italic tracking-tighter leading-none">{player.division}</span>
                      </div>
                    </td>

                    {/* Hype - Matching the high-contrast font style */}
                    <td className="px-8 py-5 text-right">
                      <span className="font-black text-blue-400 text-xl tracking-tighter tabular-nums drop-shadow-[0_0_10px_rgba(59,130,246,0.2)]">
                        {player.hype.toLocaleString()}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const ShopPanel: React.FC = () => {
  const [shopData, setShopData] = useState<{ featured: any[]; daily: any[] }>({ featured: [], daily: [] });
  const [cosmetics, setCosmetics] = useState<Record<string, CosmeticInfo>>({});
  const [loading, setLoading] = useState(true);
  const [timeUntilRotation, setTimeUntilRotation] = useState<string>("--:--:--");

  useEffect(() => {
  const fetchShop = async () => {
    if (!Defaults.ENABLE_API) {
      console.log("Shop API is disabled.");
      setLoading(false);
      return;
    }

    try {
      const res = await fetch(`${Defaults.BACKEND_URL}/api/launcher/shop`, {
        method: 'GET',
        responseType: ResponseType.JSON,
      });
      if (!res.ok) throw new Error("Shop fetch failed");

      const data = res.data as { featured?: any[]; daily?: any[]; timeUntilRotationMs?: number; timeUntilRotationText?: string };
      const featured = Array.isArray(data.featured) ? data.featured : [];
      const daily = Array.isArray(data.daily) ? data.daily : [];
      setShopData({ featured, daily });

      if (typeof data.timeUntilRotationText === "string") {
        setTimeUntilRotation(data.timeUntilRotationText);
      } else if (typeof data.timeUntilRotationMs === "number") {
        const totalSeconds = Math.max(0, Math.floor(data.timeUntilRotationMs / 1000));
        const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
        const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
        const seconds = String(totalSeconds % 60).padStart(2, "0");
        setTimeUntilRotation(`${hours}:${minutes}:${seconds}`);
      }

      const offers = [...featured, ...daily];
      const cosmeticMap: Record<string, CosmeticInfo> = {};
      const cosmeticIds: string[] = [...new Set(offers.map((offer) => {
        const grant = Array.isArray(offer.itemGrants) ? offer.itemGrants[0] : offer.itemGrants;
        const templateId = typeof grant === "string" ? grant.split(":")[1] : undefined;
        return templateId ?? "";
      }).filter((id) => Boolean(id)))];

      await Promise.all(cosmeticIds.map(async (rawId) => {
        try {
          const apiRes = await fetch(`https://fortnite-api.com/v2/cosmetics/br/${rawId}`, {
            method: "GET",
            responseType: ResponseType.JSON,
          });
          const apiData = apiRes.data as any;

          if (apiRes.ok && apiData.status === 200) {
            cosmeticMap[rawId] = {
              id: apiData.data.id,
              name: apiData.data.name,
              description: apiData.data.description,
              image: apiData.data.images.icon || apiData.data.images.smallIcon,
              rarity: apiData.data.rarity.value,
            };
          }
        } catch (error) {
          console.warn("Failed to fetch cosmetic details for", rawId, error);
        }
      }));

      setCosmetics(cosmeticMap);
    } catch (err) {
      console.error("Shop Error:", err);
    } finally {
      setLoading(false);
    }
  };

  fetchShop();
}, []);

  const getRarityStyle = (rarity: string) => {
    switch (rarity?.toLowerCase()) {
      case "legendary": return { border: "border-orange-500/40", text: "text-orange-400", bg: "from-orange-500/20" };
      case "epic": return { border: "border-purple-500/40", text: "text-purple-400", bg: "from-purple-500/20" };
      case "rare": return { border: "border-blue-500/40", text: "text-blue-400", bg: "from-blue-500/20" };
      case "uncommon": return { border: "border-green-500/40", text: "text-green-400", bg: "from-green-500/20" };
      default: return { border: "border-white/10", text: "text-slate-400", bg: "from-slate-500/10" };
    }
  };

  const RenderSection = (title: string, items: any[]) => (
  <div className="mb-12">
    <div className="flex items-center gap-6 mb-6 px-1">
      <h3 className="text-2xl font-black text-white uppercase tracking-tighter italic">{title}</h3>
      <div className="h-[1px] flex-1 bg-gradient-to-r from-white/10 to-transparent" />
    </div>
    
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5">
      {items.map((entry) => {
        const rawId = entry.itemGrants?.[0]?.split(":")[1];
        const info = rawId ? cosmetics[rawId] : undefined;
        const style = getRarityStyle(info?.rarity || "");

        return (
          <div 
            key={entry.id}
            className={`group relative rounded-xl overflow-hidden bg-[#0b1724] border transition-all duration-300 transform-gpu ${style.border}`}
          >
            <div className="aspect-square overflow-hidden relative bg-[#071422] group">
            {/* Background Gradient */}
            <div className={`absolute inset-0 bg-gradient-to-t ${style.bg} to-transparent opacity-30 z-10 transition-opacity duration-500 group-hover:opacity-40`} />
            
            {info?.image ? (
              <img 
                src={info.image} 
                onLoad={(e) => e.currentTarget.classList.remove('opacity-0')}
                className="w-full h-full object-cover relative z-0 opacity-0"
              />
            ) : (
              <div className="w-full h-full bg-[#071422]" />
            )}
            
            {/* Price Badge */}
            <div className="absolute top-3 right-3 z-30 px-2 py-1.5 rounded-md bg-black/60 backdrop-blur-xl flex items-center gap-2 border border-white/10 shadow-xl">
              {entry.price !== null && entry.price !== undefined && <>
                <img src="https://i.imgur.com/pfmvUEu.png" className="w-3.5 h-3.5" alt="V" />
                <span className="text-[11px] font-black text-white tracking-tighter uppercase italic">{entry.price}</span>
              </>}
            </div>
          </div>
            <div className="p-3 bg-black/20">
              <div className={`text-[8px] font-black uppercase tracking-widest mb-0.5 ${style.text}`}>
                {info?.rarity || "Loading..."}
              </div>
              <div className="font-bold text-white text-[11px] truncate uppercase">
                {info?.name || rawId || "Cosmetic"}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  </div>
);

const isShopEmpty = shopData.featured.length === 0 && shopData.daily.length === 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-40 w-full bg-transparent">
        <p className="text-sm text-slate-400">Loading shop...</p>
      </div>
    );
  }

  return (
    <div className="w-full h-full relative bg-transparent outline-none ring-0">
      {!isShopEmpty ? (
        <div className="px-1 pb-10">
          <div className="mb-6 flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-300">
            <span className="font-medium text-slate-200">Next rotation</span>
            <span className="font-bold tracking-wide text-blue-300">{timeUntilRotation}</span>
          </div>
          {shopData.featured.length > 0 && RenderSection("Featured", shopData.featured)}
          {shopData.daily.length > 0 && RenderSection("Daily", shopData.daily)}
        </div>
      ) : (
        <div className="w-full flex justify-center items-start pt-10">
          {/* Matches Library empty state exactly */}
          <div className="w-full max-w-2xl px-4">
            <div className="py-24 border-2 border-dashed border-white/20 rounded-2xl bg-white/[0.03] flex flex-col items-center justify-center transition-colors hover:border-white/30">
              
              {/* Icon Container: matches w-14/h-14 and bg-white/10 */}
              <div className="w-14 h-14 rounded-full bg-white/10 flex items-center justify-center mb-4 text-slate-300 shadow-inner">
                <ShoppingCart size={28} />
              </div>

              {/* Title: matches text-slate-300 text-sm font-medium */}
              <p className="text-slate-300 text-sm font-medium">
                Shop Unavailable
              </p>

              {/* Subtitle: matches text-slate-500 text-xs mt-1 */}
              <p className="text-slate-500 text-xs mt-1">
                Connection to the item store was lost. Please check back later.
              </p>

            </div>
          </div>
        </div>
      )}
    </div>
  );
};

  /* -------------------- lifecycle / persistence -------------------- */
  useEffect(() => {
    let cancelled = false;
    const savedPath = localStorage.getItem("buildPath");
    if (savedPath) setPath(savedPath);

    const savedUser = localStorage.getItem("user");
    if (savedUser) {
      try { setUser(JSON.parse(savedUser)); } catch { /* ignore */ }
    }
    setErbiumDllPath(localStorage.getItem("erbiumDllPath") || "");

    const savedBuilds = localStorage.getItem("SettingsMP.builds");
    if (savedBuilds) {
      try {
        const parsed = JSON.parse(savedBuilds) as BuildItem[];
        setBuilds(parsed);
        if (!savedPath && parsed.length > 0) setPath(parsed[0].path);
        if (hasTauriRuntime()) {
          void Promise.all(parsed.map(async (build) => {
            try {
              const version = await invoke<string>("get_fortnite_version", { gameRoot: build.path });
              return { ...build, version, versionError: undefined };
            } catch (versionError) {
              return { ...build, version: undefined, versionError: String(versionError) };
            }
          })).then((checkedBuilds) => {
            if (cancelled) return;
            setBuilds(checkedBuilds);
            localStorage.setItem("SettingsMP.builds", JSON.stringify(checkedBuilds));
          });
        }
      } catch { /* ignore */ }
    }
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    localStorage.setItem("gameSetting.eor", String(eor));
  }, [eor]);

  useEffect(() => {
    localStorage.setItem("gameSetting.bubbleBuilds", String(bubbleBuilds));
  }, [bubbleBuilds]);

  useEffect(() => {
    localStorage.setItem("gameSetting.stretchResolution", String(stretchResolutionEnabled));
    localStorage.setItem("gameSetting.resolutionWidth", String(resolutionWidth));
    localStorage.setItem("gameSetting.resolutionHeight", String(resolutionHeight));
  }, [stretchResolutionEnabled, resolutionWidth, resolutionHeight]);

  useEffect(() => {
    localStorage.setItem("SettingsMP.builds", JSON.stringify(builds));
  }, [builds]);

  useEffect(() => {
    if (path) localStorage.setItem("buildPath", path); else localStorage.removeItem("buildPath");
  }, [path]);

  /* -------------------- Fortnite process polling -------------------- */
  useEffect(() => {
    let cancelled = false;
    let requestInFlight = false;
    const run = async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const running = await invoke<boolean>("is_fortnite_client_running");
        const hostRunning = await invoke<boolean>("is_erbium_host_running");
        if (!cancelled) {
          setIsGameRunning(running);
          setIsHostRunning(hostRunning);
          if (running) setIsLaunching(false);
        }
      } catch {
        if (!cancelled && !hasTauriRuntime()) setIsGameRunning(false);
      } finally {
        requestInFlight = false;
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let unlistenStatus: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;

    void listen<string>("host-status", (event) => setHostStatus(event.payload)).then((unlisten) => {
      if (active) unlistenStatus = unlisten;
      else unlisten();
    });
    void listen<string>("host-error", (event) => {
      setHostStatus("Host stopped");
      setError(event.payload);
      setTimeout(() => setError(null), 8000);
    }).then((unlisten) => {
      if (active) unlistenError = unlisten;
      else unlisten();
    });

    return () => {
      active = false;
      unlistenStatus?.();
      unlistenError?.();
    };
  }, []);

  /* -------------------- actions -------------------- */
  const requireDesktopRuntime = () => {
    if (hasTauriRuntime()) return true;
    setError("Use the installed desktop launcher for folder access, downloads, and game launch. The browser preview cannot access native features.");
    setTimeout(() => setError(null), 7000);
    return false;
  };

  const handleBubbleBuildsToggle = async (enabled: boolean) => {
    if (!requireDesktopRuntime()) return;
    const gameRoots = [...new Set([...builds.map((build) => build.path), ...(path ? [path] : [])])];
    if (gameRoots.length === 0) {
      setError("Add or select a Fortnite build before changing Bubble Builds.");
      setTimeout(() => setError(null), 5000);
      return;
    }

    setIsApplyingBubbleBuilds(true);
    try {
      await invoke("set_bubble_builds_cmd", { gameRoots, enabled });
      setBubbleBuilds(enabled);
    } catch (toggleError) {
      setError(`Could not ${enabled ? "install" : "remove"} Bubble Builds: ${String(toggleError)}`);
      setTimeout(() => setError(null), 7000);
    } finally {
      setIsApplyingBubbleBuilds(false);
    }
  };

  const handleLaunch = async () => {
    if (!requireDesktopRuntime()) return;
    if (isHostRunning) {
      setError("Stop the Erbium host before launching a player session.");
      setTimeout(() => setError(null), 5000);
      return;
    }
    setIsLaunching(true);
    const launchPath = path || builds[0]?.path;
    if (!launchPath) {
      setError("Please first select a game folder or build in the library.");
      setTimeout(() => setError(null), 5000);
      setIsLaunching(false);
      return;
    }
    if (!user) {
      setError("No login details found.");
      setTimeout(() => setError(null), 5000);
      setIsLaunching(false);
      return;
    }

    try {
    await invoke("set_bubble_builds_cmd", { gameRoots: [launchPath], enabled: bubbleBuilds });
    await invoke("firstlaunch", {
      path: launchPath,
      email: user.email,
      password: user.password,
      eor: eor,
      disablePreedits: disablePreedits,
      stretchResolutionEnabled,
      resolutionWidth,
      resolutionHeight,
    });
  } catch (err) {
    setError("Fehler beim Start: " + String(err));
    setIsLaunching(false);
  } finally {
    if (!isGameRunning) setIsLaunching(false);
  }
  };

  const selectErbiumDll = async () => {
    if (!requireDesktopRuntime()) return null;
    const selected = await open({
      multiple: false,
      title: "Select the built Erbium.dll",
      filters: [{ name: "Erbium DLL", extensions: ["dll"] }],
    });
    if (typeof selected !== "string") return null;
    setErbiumDllPath(selected);
    localStorage.setItem("erbiumDllPath", selected);
    return selected;
  };

  const handleErbiumHost = async () => {
    if (!requireDesktopRuntime()) return;
    if (user?.isAdmin !== true) {
      setError("Only launcher admins can start the Erbium host.");
      setTimeout(() => setError(null), 5000);
      return;
    }
    if (isHostRunning) {
      try {
        await invoke("stop_erbium_host");
        setHostStatus("Stopping host...");
      } catch (stopError) {
        setError("Could not stop Erbium host: " + String(stopError));
        setTimeout(() => setError(null), 6000);
      }
      return;
    }
    if (!user?.email || !user.password) {
      setError("Sign in with a game account before starting the host.");
      setTimeout(() => setError(null), 5000);
      return;
    }

    const gameRoot = path || builds[0]?.path;
    if (!gameRoot) {
      setError("Add or select the Fortnite 13.40 build first.");
      setTimeout(() => setError(null), 5000);
      return;
    }

    let dllPath = erbiumDllPath;
    if (!dllPath) {
      const selected = await selectErbiumDll();
      if (!selected) return;
      dllPath = selected;
    }

    setIsHostStarting(true);
    setHostStatus("Preparing Erbium host...");
    try {
      await invoke("start_erbium_host", {
        gameRoot,
        email: user.email,
        password: user.password,
        erbiumDllPath: dllPath,
      });
      setIsHostRunning(true);
    } catch (hostError) {
      setHostStatus("Host stopped");
      setError("Could not start Erbium host: " + String(hostError));
      setTimeout(() => setError(null), 8000);
    } finally {
      setIsHostStarting(false);
    }
  };

  const handleCloseGame = async () => {
    if (!requireDesktopRuntime()) return;
    setIsClosingGame(true);
    try {
      await invoke("close_fortnite_client");
    } catch (closeError) {
      setError(`Could not close Fortnite: ${String(closeError)}`);
      setTimeout(() => setError(null), 7000);
    } finally {
      setIsClosingGame(false);
    }
  };

  const handleLogout = () => {
    localStorage.clear();
    setUser(null);
    setPath(null);
    setBuilds([]);
    navigate("/login");
  };

  /* -------------------- builds -------------------- */
  const addBuild = async () => {
    if (!requireDesktopRuntime()) return;
    const selected = await open({ 
      directory: true,
      multiple: false,
      title: "Select Fortnite Folder",
    });
    if (!selected || typeof selected !== "string") return;
    try {
      const hasEngine = await exists(await join(selected, "Engine"));
      if (!hasEngine) {
        setError("Invalid build: The folder must contain an 'Engine' folder.");
        setTimeout(() => setError(null), 5000);
        return;
      }
      let gameVersion: string | undefined;
      try { gameVersion = await invoke<string>("get_fortnite_version", { gameRoot: selected }); } catch { /* Version display is optional. */ }
      if (builds.length >= 2) {
        setError("Maximum builds in library reached (2). Remove one first.");
        setTimeout(() => setError(null), 5000);
        return;
      }

      const splashPath = await join(selected, "FortniteGame", "Content", "Splash", "Splash.bmp");
      const hasSplash = await exists(splashPath);

      let coverDataUrl: string | undefined;
      if (hasSplash) {
        const bytes = await readBinaryFile(splashPath);
        const b64 = bytesToBase64(bytes);
        coverDataUrl = "data:image/bmp;base64," + b64;
      }

      const item: BuildItem = {
        id: String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8),
        path: selected,
        name: getFolderName(selected),
        version: gameVersion,
        coverDataUrl,
      };
      const updatedBuilds = [item, ...builds];
      setBuilds(updatedBuilds);
      setPath(selected);
      localStorage.setItem("SettingsMP.builds", JSON.stringify(updatedBuilds));
    } catch (e) {
      setError("Could not add build: " + String(e));
      setTimeout(() => setError(null), 5000);
      return;
    }
    try {
      await invoke("sync_paks_cmd", { gameRoot: selected });
    } catch (err) {
      console.error("Could not sync local PAK files:", err);
      setError("Could not copy PAK/SIG files from Documents\\Project Fishk\\Paks: " + String(err));
      setTimeout(() => setError(null), 6000);
    }
  };

  const downloadBuild = async () => {
    if (!requireDesktopRuntime()) return;
    if (builds.length >= 2) {
      setError("The library is full. Remove a build before downloading another.");
      setTimeout(() => setError(null), 5000);
      return;
    }

    try {
      const previousDestination = localStorage.getItem("buildDownloadDirectory") ?? undefined;
      const destination = await open({
        directory: true,
        multiple: false,
        title: "Choose where to install the build",
        defaultPath: previousDestination,
      });
      if (!destination || typeof destination !== "string") return;

      localStorage.setItem("buildDownloadDirectory", destination);
      setIsDownloading(true);
      setIsBuildDownload(true);
      setProgress(0);
      setDownloadEta(null);
      setDownloadRate(0);
      setCurrentStatus("Connecting to build host...");
      setWarningMsg("");

      const installedPath = await invoke<string>("download_build_cmd", { destination });
      let gameVersion: string | undefined;
      try { gameVersion = await invoke<string>("get_fortnite_version", { gameRoot: installedPath }); } catch { /* Version display is optional. */ }
      const splashPath = await join(installedPath, "FortniteGame", "Content", "Splash", "Splash.bmp");
      let coverDataUrl: string | undefined;
      if (await exists(splashPath)) {
        coverDataUrl = `data:image/bmp;base64,${bytesToBase64(await readBinaryFile(splashPath))}`;
      }

      const item: BuildItem = {
        id: String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8),
        path: installedPath,
        name: getFolderName(installedPath),
        version: gameVersion,
        coverDataUrl,
      };
      const updatedBuilds = [item, ...builds];
      setBuilds(updatedBuilds);
      setPath(installedPath);
      localStorage.setItem("SettingsMP.builds", JSON.stringify(updatedBuilds));
      setActive("home");
    } catch (downloadError) {
      const message = `Could not download build: ${String(downloadError)}`;
      setError(message);
      setTimeout(() => setError(null), 7000);
    } finally {
      setIsDownloading(false);
    }
  };
  

  const removeBuild = (id: string) => {
    setBuilds((prev) => {
      const next = prev.filter((b) => b.id !== id);
      const removed = prev.find((b) => b.id === id);
      localStorage.setItem("SettingsMP.builds", JSON.stringify(next));
      if (removed && removed.path === path) {
        if (next[0]) setPath(next[0].path); else setPath(null);
      }
      return next;
    });
  };


const CustomTitleBar = () => (
  <div 
    data-tauri-drag-region 
    className="h-8 w-full bg-[#071422]/90 border-b border-white/10 flex justify-between items-center fixed top-0 left-0 z-[999] backdrop-blur-md select-none rounded-t-xl"
  >
    <div className="pl-4 flex items-center gap-2 pointer-events-none">
    </div>

    <div className="flex h-full">
      <button 
        onClick={() => appWindow.minimize()}
        className="px-4 h-full hover:bg-white/10 text-slate-400 transition-colors cursor-pointer"
      >
        <Minus size={14} />
      </button>
      <button 
        onClick={() => appWindow.close()}
        className="px-4 h-full hover:bg-red-600 text-slate-400 hover:text-white transition-colors cursor-pointer rounded-tr-xl"
      >
        <X size={14} />
      </button>
    </div>
  </div>
);
  /* -------------------- UI pieces (Epic-like) -------------------- */

// left nav (compact Epic style)
interface LeftNavProps {
  active: TabKey;
  setActive: (val: TabKey) => void;
  user: UserData | null;
  handleLogout: () => void;
}

const LeftNav: React.FC<LeftNavProps> = ({ active, setActive, user, handleLogout }) => (
<div className="launcher-sidebar border-r flex flex-col relative z-20">
  {/* Logo Section */}
  <div className="h-12 mb-4 flex items-center justify-center">
    <div className="launcher-brand-mark h-9 w-9 rounded-full bg-[#07080a] border border-white/10 flex items-center justify-center overflow-hidden relative">
      <img 
        src={Defaults.LOGO_URL} 
        alt="Logo" 
        className="w-full h-full object-cover transition-transform duration-500 hover:scale-110" 
      />
      <div className="absolute inset-0 border border-blue-500/10 rounded-xl pointer-events-none" />
    </div>
    
  </div>

    {/* Navigation */}
    <nav className="px-2 space-y-1 flex-1">
      <NavItem icon={<Home size={18} />} label="Home" id="home" active={active} setActive={setActive} />
      <NavItem icon={<Grid size={18} />} label="Library" id="library" active={active} setActive={setActive} />
      <NavItem icon={<ShoppingCart size={18} />} label="Shop" id="shop" active={active} setActive={setActive} />
      <NavItem icon={<Trophy size={18} />} label="Compete" id="leaderboard" active={active} setActive={setActive} />
      <NavItem icon={<Newspaper size={18} />} label="News" id="news" active={active} setActive={setActive} />
      
      <div className="my-4 mx-4 h-px bg-white/5" />
      
      <NavItem icon={<Settings size={18} />} label="Settings" id="settings" active={active} setActive={setActive} />
    </nav>

    {/* Bottom Profile */}
    <div className="p-3 mt-auto border-t border-white/5 bg-black/20">
      <div className="flex flex-col items-center gap-2">
        <div className="h-10 w-10 rounded-xl border border-white/15 overflow-hidden bg-[#292b47]">
           <img 
             src={user?.discordId && user?.avatarHash 
               ? `https://cdn.discordapp.com/avatars/${user.discordId}/${user.avatarHash}.png?size=64`
               : `https://ui-avatars.com/api/?name=${user?.username || 'G'}&background=0ea5e9&color=fff`
             } 
             className="w-full h-full object-cover" 
           />
        </div>
      <button 
        onClick={handleLogout} 
        aria-label="Sign out"
        title="Sign out"
        className="cursor-pointer p-1.5 text-slate-500 hover:text-red-400 transition-colors"
      >
        <LogOut size={16} />
      </button>
      </div>
    </div>
  </div>
);

  /* Hero carousel / featured area (Epic-like big banner) */
  const HeroBanner: React.FC = () => {
  const current = builds.find((b) => b.path === path) ?? builds[0];
  const bannerImage = current?.coverDataUrl || Defaults.PLACEHOLDER_IMAGE;

  return (
      <div className="mb-8">
        {/* MAIN BANNER */}
        <div className="launcher-hero relative rounded-md overflow-hidden border border-white/10 transition-all">
          {/* Background Image with Smoother Gradient Overlay */}
          <div className="relative h-[280px]">
            {heroVideoUnavailable ? (
              <img
                key={bannerImage}
                src={bannerImage}
                alt={current ? `${current.name} game artwork` : `${Defaults.LAUNCHER_NAME} featured artwork`}
                className="launcher-hero-image w-full h-full object-cover"
              />
            ) : (
              <video
                key="launcher-hero-video"
                src="/Videos/hero.mp4"
                poster={bannerImage}
                autoPlay
                muted
                loop
                playsInline
                preload="metadata"
                aria-hidden="true"
                onError={() => setHeroVideoUnavailable(true)}
                onCanPlay={() => setHeroVideoUnavailable(false)}
                className="launcher-hero-image w-full h-full object-cover"
              />
            )}
            <div className="absolute inset-0 bg-gradient-to-r from-[#080b0e]/95 via-[#080b0e]/55 to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-t from-[#080b0e]/65 via-transparent to-black/10" />
          </div>

          {/* Content Overlay */}
          <div className="absolute inset-0 p-7 md:p-10 flex items-end gap-6">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-3">
                 <span className="h-2 w-2 rounded-full shadow-[0_0_12px_rgba(169,165,255,0.6)]" style={{ backgroundColor: accentColor }} />
                 <span className="launcher-accent-text text-[10px] font-bold uppercase tracking-[0.22em]">
                   {current ? "Ready when you are" : "Your next session starts here"}
                 </span>
              </div>
              <h2 className="max-w-2xl text-3xl md:text-4xl font-bold text-white leading-tight drop-shadow-lg">
                Hey, {user?.username ?? user?.email?.split("@")[0] ?? "Player"}!
              </h2>
              <p className="text-sm text-slate-300 mt-2">
                {current ? `${current.name} is ready to play.` : "Download a ready build or add one you already have."}
              </p>

              <div className="mt-6 flex items-center gap-3">
                <button
                  onClick={() => current ? (isGameRunning ? handleCloseGame() : handleLaunch()) : downloadBuild()}
                  disabled={isLaunching || isClosingGame || isHostRunning || (Boolean(current) && !user && !isGameRunning)}
                  className="launcher-play-button cursor-pointer px-7 py-3 rounded-md font-bold text-sm uppercase tracking-wide transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {current ? (isHostRunning ? <Server size={17} /> : isGameRunning ? <X size={17} /> : <Play size={17} fill="currentColor" />) : <Download size={18} />}
                  {isHostRunning ? "Host running" : isClosingGame ? "Closing..." : isGameRunning ? "Close" : isLaunching ? "Running..." : current ? "Play now" : "Download build"}
                </button>

                {user?.isAdmin === true && (
                  <button
                    type="button"
                    onClick={() => void handleErbiumHost()}
                    disabled={isHostStarting || isLaunching || isClosingGame}
                    className="cursor-pointer inline-flex items-center gap-2 rounded-md border border-white/15 bg-white/5 px-5 py-3 text-sm font-semibold text-slate-100 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Server size={17} />
                    {isHostStarting ? "Starting host..." : isHostRunning ? "Stop host" : "Start Erbium host"}
                  </button>
                )}

                <button 
                  onClick={() => setActive("library")} 
                  className="cursor-pointer px-5 py-3 rounded-md bg-white/5 border border-white/15 text-slate-100 text-sm font-semibold hover:bg-white/10 transition-all"
                >
                  Browse library
                </button>
              </div>
              {user?.isAdmin === true && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <button
                    type="button"
                    onClick={() => void selectErbiumDll()}
                    className="cursor-pointer underline decoration-white/25 underline-offset-4 hover:text-white"
                  >
                    {erbiumDllPath ? "Change Erbium DLL" : "Select Erbium.dll"}
                  </button>
                  <span aria-live="polite">{hostStatus}</span>
                </div>
              )}
            </div>

            {/* Status Card (Right Side) */}
            <div className="w-64 hidden md:block">
              <div className="bg-black/40 p-4 rounded-xl border border-white/10 backdrop-blur-md">
                <div className="text-[9px] text-slate-500 font-black uppercase tracking-widest">Username</div>
                <div className="text-sm text-white font-black uppercase italic tracking-tighter mt-1 truncate">
                  {user?.email ? user.email.split("@")[0] : "Not logged in"}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <div className="h-1 flex-1 bg-white/5 rounded-full overflow-hidden">
                     <div className="h-full w-full bg-blue-500/50" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="launcher-news-item rounded-md p-4">
          <div className="text-[10px] text-slate-400 font-semibold uppercase tracking-[0.16em]">Launcher version</div>
          <div className="mt-2 text-sm font-semibold text-white">{Defaults.LAUNCHER_VERSION}</div>
        </div>
        <div className="launcher-news-item rounded-md p-4">
          <div className="text-[10px] text-slate-400 font-semibold uppercase tracking-[0.16em]">Game library</div>
          <div className="mt-2 text-sm font-semibold text-white">{builds.length} {builds.length === 1 ? "build installed" : "builds installed"}</div>
        </div>
        <div className="launcher-news-item rounded-md p-4">
          <div className="text-[10px] text-slate-400 font-semibold uppercase tracking-[0.16em]">Account</div>
          <div className="mt-2 text-sm font-semibold text-white truncate">{user?.username ?? user?.email?.split("@")[0] ?? "Guest session"}</div>
        </div>
      </div>
    </div>
  );
};

  /* Library styled like Epic store grid */
  const LibraryPanel: React.FC = () => (
  <div>
    <div className="flex items-center justify-between mb-6 px-1">
      <div>
        <div className="text-2xl font-bold text-white">Library</div>
        <div className="text-sm text-slate-400 mt-1">Launch and configure your installations</div>
      </div>
    </div>

    {/* Grid Section */}
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-5">
      {builds.length === 0 && (
        <div className="launcher-download-feature col-span-full min-h-[260px] grid grid-cols-1 md:grid-cols-[1.15fr_1fr] overflow-hidden rounded-md border border-white/10">
          <div className="relative min-h-48 overflow-hidden bg-black/30">
            <img src={Defaults.PLACEHOLDER_IMAGE} alt="Fortnite build artwork" className="absolute inset-0 h-full w-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-black/20 to-[#101619] md:bg-gradient-to-l" />
          </div>
          <div className="flex flex-col justify-center items-start p-6 md:p-8 bg-[#101619]">
            <span className="launcher-accent-text text-[10px] font-bold uppercase tracking-[0.2em]">Game library</span>
            <h3 className="mt-2 text-2xl font-semibold text-white">Your first build</h3>
            <p className="mt-2 max-w-sm text-sm leading-relaxed text-slate-400">Download and install a ready-to-play build, or add one you already have.</p>
            <div className="mt-5 flex flex-wrap gap-3">
              <button onClick={downloadBuild} className="launcher-play-button cursor-pointer inline-flex items-center gap-2 rounded-md px-4 py-2.5 text-sm font-semibold transition-colors">
                <CloudDownload size={16} /> Download build
              </button>
              <button onClick={addBuild} className="cursor-pointer rounded-md border border-white/15 px-4 py-2.5 text-sm font-semibold text-slate-200 transition-colors hover:bg-white/5">Add existing build</button>
            </div>
          </div>
        </div>
      )}
      {builds.map((b) => {
          const selected = b.path === path;
          return (
            <div 
              key={b.id} 
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              onClick={() => setPath(b.path)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setPath(b.path);
                }
              }}
              className={`group relative cursor-pointer rounded-lg overflow-hidden bg-[#0b1724]/60 border backdrop-blur-md ${
                selected ? "border-blue-500 shadow-[0_0_25px_rgba(59,130,246,0.15)]" : "border-white/10 shadow-xl shadow-black/40"
              }`}
            >
              {/* Image Section */}
              <div className="h-44 bg-[#071823] relative overflow-hidden">
                {b.coverDataUrl ? (
                  <img 
                    src={b.coverDataUrl} 
                    alt={b.name} 
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[10px] font-black text-slate-700 uppercase tracking-tighter">No Cover</div>
                )}
                
                {/* Subtle Glow Overlay */}
                <div className="absolute inset-0 bg-blue-500/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
              </div>

              {/* Info Section */}
              <div className="p-4 bg-gradient-to-b from-transparent to-black/30">
                <div className="text-sm font-bold text-white truncate group-hover:text-blue-400 transition-colors duration-300">
                  {b.name}
                </div>
                <div className="text-[10px] text-slate-500 font-bold mt-1 truncate uppercase tracking-widest opacity-80">
                  {getFolderName(b.path)}
                </div>
                <div className="mt-2 text-[10px] font-semibold text-slate-400">
                  {b.version ? `Fortnite ${b.version} detected` : b.versionError ? "Version detection unavailable" : "Detecting game version..."}
                </div>
                
                <div className="mt-4 flex items-center justify-between">
                  {/* Simplified Indicator (No Badge) */}
                  <div className={`flex items-center gap-2`}>
                  </div>
                  
                  <button 
                    onClick={(event) => { event.stopPropagation(); removeBuild(b.id); }} 
                    className="cursor-pointer p-1.5 rounded-lg text-slate-600 hover:text-red-500 hover:bg-red-500/10 transition-all duration-300"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
    </div>
    <div className="launcher-library-actions">
      <button type="button" onClick={downloadBuild} className="launcher-library-action" title="Download a build" aria-label="Download a build"><CloudDownload size={19} /></button>
      <button type="button" onClick={addBuild} className="launcher-library-action" title="Add an existing build" aria-label="Add an existing build"><Plus size={20} /></button>
    </div>
  </div>
);

  /* News / patch notes full list */
const SettingsPanel: React.FC<{
  eor: boolean; setEor: (v: boolean) => void;
  ror: boolean; setRor: (v: boolean) => void;
  disablePreedits: boolean;
  setDisablePreedits: (v: boolean) => void;
  bubbleBuilds: boolean; setBubbleBuilds: (v: boolean) => void;
  isApplyingBubbleBuilds: boolean;
  stretchResolutionEnabled: boolean; setStretchResolutionEnabled: (v: boolean) => void;
  resolutionWidth: number; setResolutionWidth: (v: number) => void;
  resolutionHeight: number; setResolutionHeight: (v: number) => void;
  mobileBuilds: boolean; setMobileBuilds: (v: boolean) => void;
  accentColor: string; setAccentColor: (color: string) => void;
  theme: LauncherTheme; onSelectTheme: (theme: LauncherTheme) => void;
  updateTrackerStatus: UpdateTrackerStatus;
  updateTrackerMessage: string;
  updateManifest: UpdateManifest | null;
  onOpenPakFolder: () => void;
  onCheckForUpdates: () => void;
  onInstallAvailableUpdate: () => void;
}> = ({ eor, setEor, ror, setRor, bubbleBuilds, setBubbleBuilds, isApplyingBubbleBuilds, stretchResolutionEnabled, setStretchResolutionEnabled, resolutionWidth, setResolutionWidth, resolutionHeight, setResolutionHeight, mobileBuilds, setMobileBuilds, accentColor, setAccentColor, theme, onSelectTheme, updateTrackerStatus, updateTrackerMessage, updateManifest, onOpenPakFolder, onCheckForUpdates, onInstallAvailableUpdate }) => {

  return (
    <div className="max-w-5xl mx-auto">
      
      {/* HEADER SECTION */}
      <div className="flex items-center justify-between mb-8 px-1">
        <div>
          <div className="text-2xl font-black text-white uppercase tracking-tighter italic">Preferences</div>
          <div className="text-[10px] text-blue-400 font-bold tracking-[0.2em] mt-0.5 uppercase opacity-90">Game Settings</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-stretch">
        
        {/* GAMEPLAY MECHANICS CARD */}
        <div className="p-10 rounded-2xl border-2 border-white/10 bg-[#0b1724]/60 backdrop-blur-xl shadow-2xl transition-all hover:bg-[#0b1724]/80 flex flex-col justify-between">
          <h3 className="mb-5 text-xs font-black uppercase tracking-[0.18em] text-blue-300">Gameplay</h3>
          <div className="flex items-center justify-between group">
            <div>
              <p className="text-sm font-black text-slate-200 group-hover:text-white transition-colors uppercase italic tracking-tighter">Edit on Release</p>
              <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-0.5">Instant Edit</p>
            </div>
            <button
              type="button"
              onClick={() => setEor(!eor)} 
              className={`cursor-pointer relative inline-flex h-7 w-12 items-center rounded-full transition-all duration-300 ${eor ? "bg-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.4)]" : "bg-white/10"}`}
            >
              <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-lg transition-transform duration-300 ${eor ? "translate-x-6" : "translate-x-1"}`} />
            </button>
          </div>

          <div className="h-px bg-white/5" />

          {/* Reset on Release */}
          <div className="flex items-center justify-between group">
            <div>
              <p className="text-sm font-black text-slate-200 group-hover:text-white transition-colors uppercase italic tracking-tighter">Reset on Release</p>
              <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-0.5 text-amber-500/80">IN DEVELOPMENT: Instant Reset</p>
            </div>
            <button
              type="button"
              onClick={() => setRor(!ror)} 
              className={`cursor-pointer relative inline-flex h-7 w-12 items-center rounded-full transition-all duration-300 ${ror ? "bg-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.4)]" : "bg-white/10"}`}
            >
              <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-lg transition-transform duration-300 ${ror ? "translate-x-6" : "translate-x-1"}`} />
            </button>
          </div>

          <div className="h-px bg-white/5" />

          {/* Disable Pre-edits */}
          <div className="flex items-center justify-between group">
            <div>
              <p className="text-sm font-black text-slate-200 group-hover:text-white transition-colors uppercase italic tracking-tighter">Disable Pre-edits</p>
              <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-0.5">Removes Pre-edit delay</p>
            </div>
            <button
              type="button"
              onClick={() => setDisablePreedits(!disablePreedits)} 
              className={`cursor-pointer relative inline-flex h-7 w-12 items-center rounded-full transition-all duration-300 ${disablePreedits ? "bg-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.4)]" : "bg-white/10"}`}
            >
              <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-lg transition-transform duration-300 ${disablePreedits ? "translate-x-6" : "translate-x-1"}`} />
            </button>
          </div>
          <div className="pt-6" /> 
        </div>
        <div className="p-8 rounded-2xl border-2 border-white/10 bg-[#0b1724]/60 backdrop-blur-xl shadow-2xl transition-all hover:bg-[#0b1724]/80">
          <div className="mb-6">
            <h3 className="text-xs font-black uppercase tracking-[0.18em] text-cyan-300">Display</h3>
            <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">Resolution</p>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-black uppercase italic tracking-tighter text-slate-200">Stretch resolution</p>
              <p className="mt-0.5 text-xs text-slate-500">Applies when Fortnite launches</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-label="Stretch resolution"
              aria-checked={stretchResolutionEnabled}
              onClick={() => setStretchResolutionEnabled(!stretchResolutionEnabled)}
              className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full transition-all ${stretchResolutionEnabled ? "bg-cyan-500" : "bg-white/10"}`}
            >
              <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-lg transition-transform ${stretchResolutionEnabled ? "translate-x-6" : "translate-x-1"}`} />
            </button>
          </div>
          <div className={`mt-6 grid grid-cols-2 gap-3 ${stretchResolutionEnabled ? "" : "opacity-45"}`}>
            <label className="text-xs font-semibold text-slate-400">
              Width
              <input
                type="number"
                min={640}
                max={7680}
                step={10}
                value={resolutionWidth}
                disabled={!stretchResolutionEnabled}
                onChange={(event) => setResolutionWidth(Math.max(640, Math.min(7680, Number(event.target.value) || 1600)))}
                className="mt-2 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400/60 disabled:cursor-not-allowed"
              />
            </label>
            <label className="text-xs font-semibold text-slate-400">
              Height
              <input
                type="number"
                min={480}
                max={4320}
                step={10}
                value={resolutionHeight}
                disabled={!stretchResolutionEnabled}
                onChange={(event) => setResolutionHeight(Math.max(480, Math.min(4320, Number(event.target.value) || 1080)))}
                className="mt-2 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400/60 disabled:cursor-not-allowed"
              />
            </label>
          </div>
          <div className="mt-5 flex min-h-28 items-center justify-center rounded-md border border-white/10 bg-black/25 p-3">
            <div
              className="flex max-h-24 max-w-full items-center justify-center border border-cyan-300/50 bg-cyan-300/10 px-3 text-center text-xs font-semibold text-cyan-100"
              style={{ aspectRatio: `${resolutionWidth} / ${resolutionHeight}`, width: `${Math.min(100, (resolutionWidth / resolutionHeight) * 56)}%` }}
            >
              {resolutionWidth} x {resolutionHeight}
            </div>
          </div>
        </div>
        {/* RIGHT COLUMN */}
        <div className="flex flex-col gap-6">
          <div className="p-8 rounded-2xl border-2 border-white/10 bg-[#0b1724]/60 backdrop-blur-xl shadow-2xl transition-all hover:bg-[#0b1724]/80">
            <div className="flex items-center gap-4 mb-10">
              <div className="w-12 h-12 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 shadow-[0_0_20px_rgba(168,85,247,0.1)]">
                <Grid size={24} />
              </div>
              <div>
                <h4 className="text-sm font-black text-white uppercase tracking-tight italic">Performance</h4>
                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Visual</p>
              </div>
            </div>

            <div className="space-y-8">
              <div className="flex items-center justify-between group">
                <div>
                  <p className="text-sm font-black text-slate-200 group-hover:text-white transition-colors uppercase italic tracking-tighter">Bubble Builds</p>
                  <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-0.5">Installs or removes the Bubble pack</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={bubbleBuilds}
                  disabled={isApplyingBubbleBuilds}
                  onClick={() => void setBubbleBuilds(!bubbleBuilds)}
                  className={`cursor-pointer relative inline-flex h-7 w-12 items-center rounded-full transition-all duration-300 disabled:cursor-wait disabled:opacity-60 ${bubbleBuilds ? "bg-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.4)]" : "bg-white/10"}`}
                >
                  <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-lg transition-transform duration-300 ${bubbleBuilds ? "translate-x-6" : "translate-x-1"}`} />
                </button>
              </div>

              <div className="h-px bg-white/5" />

              <div className="flex items-center justify-between group">
                <div>
                  <p className="text-sm font-black text-slate-200 group-hover:text-white transition-colors uppercase italic tracking-tighter">Mobile Builds</p>
                  <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-0.5">IN DEVELOPMENT Low Meshes</p>
                </div>
                <button
                  type="button"
                  onClick={() => setMobileBuilds(!mobileBuilds)}
                  className={`cursor-pointer relative inline-flex h-7 w-12 items-center rounded-full transition-all duration-300 ${mobileBuilds ? "bg-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.4)]" : "bg-white/10"}`}
                >
                  <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-lg transition-transform duration-300 ${mobileBuilds ? "translate-x-6" : "translate-x-1"}`} />
                </button>
              </div>
            </div>
          </div>
          
          <div className="p-5 rounded-2xl border-2 border-white/10 bg-[#0b1724]/60 backdrop-blur-xl shadow-2xl flex items-center justify-between transition-all hover:bg-[#0b1724]/80 group">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-lg bg-green-500/10 border border-green-500/20 flex items-center justify-center text-green-400 shadow-[0_0_15px_rgba(34,197,94,0.1)]">
                <Play size={18} fill="currentColor" className="ml-0.5" />
              </div>
              <div>
                <p className="text-[10px] text-slate-500 font-black uppercase tracking-[0.2em]">Launcher Build</p>
                <p className="text-sm text-white font-black uppercase italic tracking-tighter">{Defaults.LAUNCHER_VERSION}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="launcher-surface md:col-span-2 rounded-md p-6">
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-white">Launcher theme</h3>
            <p className="mt-1 text-xs text-slate-400">Choose a saved color atmosphere for this device.</p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="Launcher theme">
            {launcherThemes.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => onSelectTheme(preset.id)}
                aria-pressed={theme === preset.id}
                className={`flex min-w-0 items-center gap-3 rounded-md border px-3 py-2 text-left text-xs font-semibold transition-colors ${theme === preset.id ? "border-white/50 bg-white/10 text-white" : "border-white/10 text-slate-300 hover:bg-white/5"}`}
              >
                <span className="flex h-6 w-8 shrink-0 overflow-hidden rounded-sm border border-white/20" aria-hidden="true">
                  {preset.colors.map((color) => <span key={color} className="h-full flex-1" style={{ backgroundColor: color }} />)}
                </span>
                <span className="truncate">{preset.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="launcher-surface md:col-span-2 flex flex-wrap items-center justify-between gap-6 rounded-md p-6">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-white">Local PAK / SIG files</h3>
            <p className="mt-2 text-xs text-slate-400">Place files in Documents/Project Fishk/Paks. New files are copied into game builds when added or launched.</p>
          </div>
          <button
            type="button"
            onClick={onOpenPakFolder}
            className="launcher-play-button flex shrink-0 cursor-pointer items-center gap-2 rounded-md px-4 py-2 text-xs font-bold"
          >
            <FolderOpen size={15} />
            Open PAK folder
          </button>
        </div>

        <div className="launcher-surface md:col-span-2 flex flex-wrap items-center justify-between gap-6 rounded-md p-6">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-white">Software updates</h3>
              <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${updateTrackerStatus === "available" ? "bg-emerald-400/15 text-emerald-200" : updateTrackerStatus === "error" ? "bg-amber-400/15 text-amber-200" : "bg-white/10 text-slate-300"}`}>
                {updateTrackerStatus === "available" ? "Update available" : updateTrackerStatus === "checking" ? "Checking" : updateTrackerStatus === "installing" ? "Installing" : updateTrackerStatus === "current" ? "Up to date" : updateTrackerStatus === "browser" ? "Desktop app required" : "Updates disabled"}
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-400">{updateTrackerMessage}</p>
            {updateManifest?.body && <p className="mt-2 text-xs text-slate-300">{updateManifest.body}</p>}
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={onCheckForUpdates}
              disabled={updateTrackerStatus === "checking" || updateTrackerStatus === "installing" || updateTrackerStatus === "setup" || updateTrackerStatus === "browser"}
              className="cursor-pointer rounded-md border border-white/15 px-4 py-2 text-xs font-semibold text-slate-200 transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {updateTrackerStatus === "checking" ? "Checking..." : "Check for updates"}
            </button>
            {updateTrackerStatus === "available" && (
              <button
                type="button"
                onClick={onInstallAvailableUpdate}
                className="launcher-play-button cursor-pointer rounded-md px-4 py-2 text-xs font-bold"
              >
                Install & restart
              </button>
            )}
          </div>
        </div>

        <div className="launcher-surface md:col-span-2 flex flex-wrap items-center justify-between gap-6 rounded-md p-6">
          <div>
            <h3 className="text-sm font-semibold text-white">Accent color</h3>
            <p className="mt-1 text-xs text-slate-400">Personalize the launcher highlights. This is saved on this device.</p>
          </div>
          <div className="flex items-center gap-3">
            {[
              { name: "Lime", color: "#d8ff70" },
              { name: "Mint", color: "#8be6df" },
              { name: "Coral", color: "#ff9c78" },
              { name: "Sky", color: "#78c9ff" },
            ].map((option) => (
              <button
                key={option.name}
                type="button"
                aria-label={`${option.name} accent`}
                aria-pressed={accentColor.toLowerCase() === option.color}
                title={`${option.name} accent`}
                onClick={() => setAccentColor(option.color)}
                className={`h-8 w-8 rounded-full border-2 transition-transform hover:scale-110 ${accentColor.toLowerCase() === option.color ? "border-white" : "border-white/20"}`}
                style={{ backgroundColor: option.color }}
              />
            ))}
            <label className="flex h-9 w-9 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-white/20 bg-white/5" title="Choose custom accent color">
              <input
                type="color"
                aria-label="Choose custom accent color"
                value={accentColor}
                onChange={(event) => setAccentColor(event.target.value)}
                className="h-12 w-12 cursor-pointer border-0 bg-transparent p-0"
              />
            </label>
          </div>
        </div>

      </div>
    </div>
  );
};

  const [LeaderboardPanelView] = useState<React.FC>(() => LeaderboardPanel);
  const [ShopPanelView] = useState<React.FC>(() => ShopPanel);

  const selectTheme = (nextTheme: LauncherTheme) => {
    const preset = launcherThemes.find((item) => item.id === nextTheme);
    if (!preset) return;
    setTheme(nextTheme);
    setAccentColor(preset.accent);
    localStorage.setItem("launcherTheme", nextTheme);
    localStorage.setItem("launcherAccentColor", preset.accent);
  };

/* -------------------- Render main layout -------------------- */
  return (
  <div className="launcher-app w-screen h-screen flex text-slate-100 relative overflow-hidden rounded-xl border border-white/10" data-theme={theme} style={{ "--launcher-lime": accentColor } as React.CSSProperties}>

    {CustomTitleBar()}

    {/* Main content */}
    <div className="relative z-10 flex w-full h-full pt-8">
      {/* Pass props to LeftNav */}
      {LeftNav({ active, setActive, user, handleLogout })}

      <div className="flex-1 flex flex-col min-w-0">
        {/* Pass user to TopBar */}
        {error && (
          <div className="absolute right-6 top-6 z-50">
            <div className="bg-red-600/90 text-white px-4 py-2 rounded-md shadow-lg border border-red-500/50">
              {error}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-auto p-4 md:p-5 custom-scrollbar">
  <div>
    {active === "home" && (
      <TabTransition key="home">
        {HeroBanner({})}
        
        {/* Container with items-stretch to force equal height columns */}
        <div className="flex flex-col lg:flex-row items-stretch gap-6 mt-4">
          
          {/* FEATURED & HIGHLIGHTS */}
          <div className="flex-[3] flex flex-col">
            <div className="launcher-surface flex-1 p-5 md:p-6 rounded-md flex flex-col">
              <div className="flex items-center justify-between gap-4 mb-5">
                <div>
                  <h3 className="text-lg font-semibold text-white">Installed builds</h3>
                  <p className="text-xs text-slate-400 mt-1">Choose which version to launch</p>
                </div>
                <button onClick={() => setActive("library")} className="launcher-accent-text cursor-pointer shrink-0 text-xs font-semibold hover:text-white transition-colors">Manage library <span aria-hidden="true">→</span></button>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 flex-1">
                {builds.length === 0 ? (
                  <div className="min-h-28 col-span-full flex flex-col items-center justify-center rounded-md border border-dashed border-white/15 text-center">
                    <p className="text-sm font-medium text-slate-300">No builds installed yet</p>
                    <button onClick={downloadBuild} className="launcher-accent-text cursor-pointer mt-3 text-xs font-semibold hover:text-white transition-colors">Download your first build <span aria-hidden="true">→</span></button>
                  </div>
                ) : (
                  builds.slice(0, 4).map(b => (
                    <div
                      key={b.id} 
                      role="button"
                      tabIndex={0}
                      aria-pressed={b.path === path}
                      onClick={() => setPath(b.path)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setPath(b.path);
                        }
                      }}
                      className={`group relative rounded-md overflow-hidden border flex h-24 cursor-pointer transition-all duration-300 ease-out ${b.path === path ? "border-white/30" : "border-white/10 bg-black/20 hover:border-white/25"}`}
                      style={b.path === path ? { borderColor: accentColor, backgroundColor: `${accentColor}10` } : undefined}
                    >
                      {/* Thumbnail Section */}
                      <div className="w-24 h-full overflow-hidden bg-black/40 border-r border-white/5 shrink-0 relative">
                        {b.coverDataUrl ? (
                          <img 
                            src={b.coverDataUrl} 
                            alt={b.name} 
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full grid place-items-center text-slate-700">
                            <Grid size={16} />
                          </div>
                        )}
                      </div>

                      {/* Info Section */}
                      <div className="p-3 flex-1 min-w-0 flex items-center justify-between relative z-10">
                        <div className="min-w-0 pr-2">
                          <div className="font-black text-white uppercase italic tracking-tighter truncate text-sm group-hover:text-[#0ea5e9] transition-colors duration-300">
                            {b.name}
                          </div>
                          <div className="text-[9px] text-slate-500 font-bold uppercase tracking-widest mt-0.5 truncate group-hover:text-slate-300 transition-colors duration-300">
                            {getFolderName(b.path)}
                          </div>
                        </div>
                        
                        {/* Remove Button - Matches height and always visible */}
                        <button 
                          onClick={(event) => { event.stopPropagation(); removeBuild(b.id); }} 
                          className="cursor-pointer p-2.5 rounded-lg bg-white/5 text-slate-500 hover:text-red-500 hover:bg-red-500/20 transition-all duration-300 shrink-0 border border-transparent hover:border-red-500/20"
                          title="Remove build"
                          aria-label={`Remove ${b.name} from library`}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                      
                      {/* Left Side Accent - Smoothly slides into view from top to bottom */}
                      <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-[#0ea5e9] opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                    </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </TabTransition>
          )}
            {active === "library" && (
              <TabTransition key="library">
                {LibraryPanel({})}
              </TabTransition>
            )}

            {active === "news" && (
              <TabTransition key="news">
                <NewsPanel user={user} />
              </TabTransition>
            )}

            {active === "shop" && (
              <TabTransition key="shop">
                <ShopPanelView />
              </TabTransition>
            )}

            {active === "settings" && (
              <TabTransition key="settings">
                {SettingsPanel({
                  eor, setEor, ror, setRor,
                  disablePreedits, setDisablePreedits,
                  bubbleBuilds, setBubbleBuilds: handleBubbleBuildsToggle,
                  isApplyingBubbleBuilds,
                  stretchResolutionEnabled, setStretchResolutionEnabled,
                  resolutionWidth, setResolutionWidth,
                  resolutionHeight, setResolutionHeight,
                  mobileBuilds, setMobileBuilds,
                  accentColor,
                  theme,
                  onSelectTheme: selectTheme,
                  setAccentColor: (color) => {
                    setAccentColor(color);
                    localStorage.setItem("launcherAccentColor", color);
                  },
                  updateTrackerStatus,
                  updateTrackerMessage,
                  updateManifest,
                  onOpenPakFolder: async () => {
                    try {
                      await invoke("open_pak_drop_folder_cmd");
                    } catch (folderError) {
                      setError("Could not open the PAK folder: " + String(folderError));
                      setTimeout(() => setError(null), 5000);
                    }
                  },
                  onCheckForUpdates: checkForUpdates,
                  onInstallAvailableUpdate: installAvailableUpdate,
                })}
              </TabTransition>
            )}

            {active === "leaderboard" && (
              <TabTransition key="leaderboard">
                <LeaderboardPanelView />
              </TabTransition>
            )}
          </div>
            {isDownloading && (
              <div
                className="fixed inset-0 z-[999] flex items-center justify-center bg-black/75 p-4 backdrop-blur-md"
              >
                <div
                  className={`grid w-full max-w-[760px] overflow-hidden rounded-lg border bg-[#101820] text-left shadow-2xl transition-colors duration-300 md:grid-cols-[260px_minmax(0,1fr)] ${warningMsg ? "border-red-500 shadow-red-500/20" : "border-white/10"}`}
                >
                  <div className="relative min-h-36 overflow-hidden bg-black/40 md:min-h-[340px]">
                    <img src={Defaults.PLACEHOLDER_IMAGE} alt="Game artwork" className="absolute inset-0 h-full w-full object-cover opacity-75" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-transparent" />
                    <div className="absolute bottom-5 left-5 right-5">
                      <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/65">Game library</div>
                      <div className="mt-1 text-xl font-bold text-white">Fortnite</div>
                      <div className="mt-1 text-xs text-white/65">{isBuildDownload ? "Build download" : "File sync"}</div>
                    </div>
                  </div>
                  <div className="min-w-0 p-5 md:p-7">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">{warningMsg ? "Download issue" : currentStatus || "Preparing download"}</p>
                        <h2 className="mt-2 truncate text-xl font-bold text-white">{warningMsg ? "Could not finish" : progress >= 100 && isBuildDownload ? "Installing build" : "Downloading game"}</h2>
                      </div>
                      {warningMsg ? <X className="mt-1 shrink-0 text-red-400" size={20} /> : <Download className="mt-1 shrink-0 text-[var(--launcher-lime)]" size={20} />}
                    </div>

                    <div className="mt-7 flex items-end justify-between gap-4">
                      <span className="text-sm text-slate-400">{warningMsg || "Progress"}</span>
                      <span className="text-3xl font-bold tabular-nums text-white">{Math.max(0, Math.min(progress, 100))}%</span>
                    </div>
                    <div
                      className="mt-3 h-2 overflow-hidden rounded-full bg-white/10"
                      role="progressbar"
                      aria-label="Build download progress"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.max(0, Math.min(progress, 100))}
                    >
                      <div
                        className={`h-full rounded-full ${warningMsg ? "bg-red-500" : "bg-[var(--launcher-lime)]"}`}
                        style={{ width: `${Math.max(0, Math.min(progress, 100))}%` }}
                      />
                    </div>

                    <div className="mt-5 flex items-center justify-between border-t border-white/10 pt-4">
                      <span className="text-xs font-medium text-slate-300">Transfer details</span>
                      <button
                        type="button"
                        onClick={() => setShowDownloadDetails((visible) => !visible)}
                        className="grid h-9 w-9 place-items-center rounded-md text-slate-300 transition hover:bg-white/10 hover:text-white"
                        aria-label={showDownloadDetails ? "Hide download details" : "Show download details"}
                        title={showDownloadDetails ? "Hide download details" : "Show download details"}
                      >
                        {showDownloadDetails ? <EyeOff size={17} /> : <Eye size={17} />}
                      </button>
                    </div>
                      {showDownloadDetails && (
                        <div
                          className="grid grid-cols-2 gap-x-5 gap-y-4 overflow-hidden pt-2"
                        >
                          <div><div className="text-[10px] uppercase tracking-wider text-slate-500">Speed</div><div className="mt-1 text-sm font-semibold text-white">{downloadRate > 0 ? formatTransferRate(downloadRate) : "Calculating"}</div></div>
                          <div><div className="text-[10px] uppercase tracking-wider text-slate-500">Network rate</div><div className="mt-1 text-sm font-semibold text-white">{downloadRate > 0 ? `${(downloadRate * 8 / 1_000_000).toFixed(1)} Mbps` : "Calculating"}</div></div>
                          <div><div className="text-[10px] uppercase tracking-wider text-slate-500">Downloaded</div><div className="mt-1 text-sm font-semibold text-white">{formatBytes(downloadedBytes)} / {formatBytes(downloadTotalBytes)}</div></div>
                          <div><div className="text-[10px] uppercase tracking-wider text-slate-500">Time remaining</div><div className="mt-1 text-sm font-semibold text-white">{progress >= 100 ? "Finishing up" : formatEta(downloadEta)}</div></div>
                        </div>
                      )}
                  </div>
                </div>
              </div>
            )}
        </div>
      </div>
    </div>
  </div>
);
}