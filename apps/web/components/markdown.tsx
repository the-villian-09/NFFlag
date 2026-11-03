import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isSiteImage, isSitePath } from "@/lib/links";

/**
 * Renders admin-edited Markdown. Raw HTML in the source is NOT rendered
 * (react-markdown's default), so page content can't inject scripts.
 * Works in server and client components (used by the admin preview).
 */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href = "", children }) {
            if (isSitePath(href)) return <Link href={href}>{children}</Link>;
            const safe = /^(https?:|mailto:|tel:)/i.test(href) ? href : undefined;
            return (
              <a href={safe} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
          // Only the site's own pictures (e.g. /images/…); no images from other sites.
          img({ src, alt }) {
            const url = typeof src === "string" ? src : "";
            if (!isSiteImage(url)) return null;
            // eslint-disable-next-line @next/next/no-img-element
            return <img src={url} alt={alt ?? ""} loading="lazy" />;
          },
          table({ children }) {
            return (
              <div className="table-wrap">
                <table>{children}</table>
              </div>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
