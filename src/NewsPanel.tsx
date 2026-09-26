import { useEffect, useState, type FormEvent } from "react";
import { Body, fetch as tauriFetch, ResponseType } from "@tauri-apps/api/http";
import { ImagePlus, Newspaper, RefreshCw, Send, Video, X } from "lucide-react";
import { Defaults } from "./defaults";

type NewsUser = {
  email: string;
  password?: string;
  username?: string;
  isAdmin?: boolean;
};

type NewsItem = {
  id: string;
  title: string;
  body: string;
  mediaPath: string | null;
  mediaType: string | null;
  author: string;
  publishedAt: string;
};

type NewsResponse = { items?: NewsItem[]; item?: NewsItem; message?: string };

const acceptedMediaTypes = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm",
]);

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read the selected file."));
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.readAsDataURL(file);
  });
}

export default function NewsPanel({ user }: { user: NewsUser | null }) {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState("");

  const loadNews = async () => {
    setLoading(true);
    setLoadError("");
    try {
      const response = await tauriFetch<NewsResponse>(`${Defaults.BACKEND_URL}/api/news`, {
        method: "GET",
        responseType: ResponseType.JSON,
      });
      if (!response.ok) throw new Error(`News service returned HTTP ${response.status}.`);
      setItems(response.data?.items ?? []);
    } catch (error) {
      setLoadError(`Could not load announcements: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadNews();
  }, []);

  useEffect(() => {
    if (!mediaFile) {
      setPreviewUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(mediaFile);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [mediaFile]);

  const handleMediaChange = (file?: File) => {
    setPublishError("");
    if (!file) {
      setMediaFile(null);
      return;
    }
    if (!acceptedMediaTypes.has(file.type)) {
      setPublishError("Choose a JPG, PNG, WebP, GIF, MP4, or WebM file.");
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setPublishError("Media must be smaller than 50 MB.");
      return;
    }
    setMediaFile(file);
  };

  const publishNews = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPublishError("");
    if (!user?.email || !user.password) {
      setPublishError("Sign out and sign in again before publishing.");
      return;
    }

    setPublishing(true);
    try {
      const mediaData = mediaFile ? await fileToDataUrl(mediaFile) : null;
      const response = await tauriFetch<NewsResponse>(`${Defaults.BACKEND_URL}/api/news`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: Body.json({
          email: user.email,
          password: user.password,
          title,
          body,
          mediaData,
        }),
        responseType: ResponseType.JSON,
      });
      if (!response.ok || !response.data?.item) {
        throw new Error(response.data?.message || "Could not publish this announcement.");
      }
      setItems((current) => [response.data!.item!, ...current]);
      setTitle("");
      setBody("");
      setMediaFile(null);
      setPreviewUrl(null);
    } catch (error) {
      setPublishError(String(error));
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl pb-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">News</h1>
          <p className="mt-1 text-sm text-slate-400">Announcements and updates from the team</p>
        </div>
        <button type="button" onClick={() => void loadNews()} disabled={loading} title="Refresh news" aria-label="Refresh news" className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-white/10 text-slate-300 transition hover:bg-white/5 disabled:opacity-50">
          <RefreshCw size={16} />
        </button>
      </div>

      {user?.isAdmin && (
        <form onSubmit={publishNews} className="launcher-surface mb-6 rounded-md p-5 md:p-6">
          <div className="mb-5 flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-md bg-[var(--launcher-lime)]/10 text-[var(--launcher-lime)]"><Newspaper size={18} /></div>
            <div>
              <h2 className="text-sm font-semibold text-white">Publish an announcement</h2>
              <p className="mt-0.5 text-xs text-slate-400">Visible to everyone using this launcher backend.</p>
            </div>
          </div>
          <div className="grid gap-3">
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required placeholder="Announcement title" className="w-full rounded-md border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-[var(--launcher-lime)]" />
            <textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={5000} required rows={4} placeholder="Write your update" className="w-full resize-y rounded-md border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-[var(--launcher-lime)]" />
          </div>
          {previewUrl && mediaFile && (
            <div className="relative mt-4 max-w-md overflow-hidden rounded-md border border-white/10 bg-black/30">
              {mediaFile.type.startsWith("video/") ? <video src={previewUrl} controls className="max-h-64 w-full object-contain" /> : <img src={previewUrl} alt="Selected announcement media" className="max-h-64 w-full object-contain" />}
              <button type="button" onClick={() => handleMediaChange()} title="Remove media" aria-label="Remove media" className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-md bg-black/70 text-white"><X size={16} /></button>
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-white/15 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-white/5">
              {mediaFile?.type.startsWith("video/") ? <Video size={16} /> : <ImagePlus size={16} />}
              {mediaFile ? mediaFile.name : "Add photo or video"}
              <input type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm" className="sr-only" onChange={(event) => handleMediaChange(event.target.files?.[0])} />
            </label>
            <button type="submit" disabled={publishing} className="launcher-play-button inline-flex cursor-pointer items-center gap-2 rounded-md px-4 py-2.5 text-xs font-bold disabled:cursor-wait disabled:opacity-60">
              {publishing ? <span>Working...</span> : <Send size={15} />}
              {publishing ? "Publishing..." : "Publish"}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">JPG, PNG, WebP, GIF, MP4, or WebM · up to 50 MB</p>
          {publishError && <p role="alert" className="mt-3 text-xs text-red-300">{publishError}</p>}
        </form>
      )}

      {loadError && <p role="alert" className="mb-4 rounded-md border border-red-400/20 bg-red-500/10 p-3 text-xs text-red-200">{loadError}</p>}
      {loading && items.length === 0 ? (
        <div className="launcher-surface grid min-h-52 place-items-center rounded-md text-sm text-slate-400">Loading announcements...</div>
      ) : items.length === 0 ? (
        <div className="launcher-surface flex min-h-52 flex-col items-center justify-center rounded-md px-6 py-12 text-center">
          <Newspaper className="mb-3 text-slate-500" size={24} />
          <p className="text-sm font-medium text-slate-200">No announcements yet</p>
          <p className="mt-1 text-xs text-slate-500">New updates from the team will appear here.</p>
        </div>
      ) : (
        <div className="divide-y divide-white/10 border-y border-white/10">
          {items.map((item) => (
            <article key={item.id} className="grid gap-4 py-5 md:grid-cols-[minmax(0,1fr)_260px]">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-white">{item.title}</h2>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">{item.body}</p>
                <p className="mt-4 text-[11px] text-slate-500">{item.author} · {new Date(item.publishedAt).toLocaleString()}</p>
              </div>
              {item.mediaPath && item.mediaType && (
                <div className="overflow-hidden rounded-md border border-white/10 bg-black/20">
                  {item.mediaType.startsWith("video/") ? (
                    <video src={`${Defaults.BACKEND_URL}${item.mediaPath}`} controls preload="metadata" className="max-h-64 w-full object-contain" />
                  ) : (
                    <img src={`${Defaults.BACKEND_URL}${item.mediaPath}`} alt={item.title} className="max-h-64 w-full object-contain" />
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}