import { APP_URL, DOCS_URL, GITHUB_URL } from "../content/site";
import { Logo } from "./Logo";

export function Footer() {
  return (
    <footer className="footer">
      <div className="container footer-grid">
        <div className="footer-brand">
          <Logo />
          <p className="muted">An open-source home assistant speaker. Built in London, runs in your home.</p>
        </div>
        <nav aria-label="Product">
          <h4>Product</h4>
          <a href="/#features">Features</a>
          <a href="/#integrations">Integrations</a>
          <a href="/#development">Development</a>
          <a href={APP_URL}>App</a>
        </nav>
        <nav aria-label="Project">
          <h4>Project</h4>
          <a href={GITHUB_URL}>GitHub</a>
          <a href={DOCS_URL}>Docs</a>
          <a href="/blog">Blog</a>
          <a href={`${GITHUB_URL}/issues`}>Issues</a>
        </nav>
      </div>
      <div className="container footer-bottom">
        <span className="muted">
          © {new Date().getFullYear()} Alexsay. Open source under the terms in the repository.
        </span>
      </div>
    </footer>
  );
}
