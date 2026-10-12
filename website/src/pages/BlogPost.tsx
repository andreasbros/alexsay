import type { ComponentType } from "react";
import { Link, useParams } from "react-router";
import { formatDate, isPublished, postBySlug } from "../content/posts";
import { FirstRelease } from "../posts/FirstRelease";
import { OpenStack } from "../posts/OpenStack";
import { WhyAlexsay } from "../posts/WhyAlexsay";
import { NotFound } from "./NotFound";

const BODIES: Record<string, ComponentType> = {
  "alexsay-0-1-first-release": FirstRelease,
  "open-source-voice-assistant-speaker": OpenStack,
  "why-alexsay": WhyAlexsay,
};

export function BlogPost() {
  const { slug = "" } = useParams();
  const post = postBySlug(slug);
  const Body = BODIES[slug];
  // The prerender writes every post; in the browser one that is not out yet is a 404, as the Worker serves it
  const early = typeof window !== "undefined" && post !== undefined && !isPublished(post, Date.now());
  if (!post || !Body || early) {
    return <NotFound />;
  }
  return (
    <article className="section post">
      <div className="container post-inner">
        <p className="eyebrow post-crumb">
          <Link to="/blog">Blog</Link>
        </p>
        <h1>{post.title}</h1>
        <p className="post-meta muted">
          <time dateTime={post.published}>{formatDate(post.published)}</time> · {post.minutes} min read
        </p>
        <div className="prose">
          <Body />
        </div>
        <p className="post-back">
          <Link to="/blog">More from the blog</Link>
        </p>
      </div>
    </article>
  );
}
