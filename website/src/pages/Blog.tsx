import { Link } from "react-router";
import { BLOG_DESCRIPTION, formatDate, postPath, visibleNow } from "../content/posts";

export function Blog() {
  const posts = visibleNow();
  return (
    <section className="section blog">
      <div className="container blog-inner">
        <div className="section-head">
          <p className="eyebrow">Blog</p>
          <h1>Notes from the bench.</h1>
          <p className="lead">{BLOG_DESCRIPTION}</p>
        </div>
        <ol className="post-list">
          {posts.map((post) => (
            <li key={post.slug} className="post-card" data-publish={post.published}>
              <time dateTime={post.published}>{formatDate(post.published)}</time>
              <h2>
                <Link to={postPath(post.slug)}>{post.title}</Link>
              </h2>
              <p>{post.description}</p>
              <span className="muted">{post.minutes} min read</span>
            </li>
          ))}
        </ol>
        <p className="blog-feed">
          <a href="/blog/feed.xml">Subscribe with RSS</a>
        </p>
      </div>
    </section>
  );
}
