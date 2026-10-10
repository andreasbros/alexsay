import { Link } from "react-router";

export function NotFound() {
  return (
    <section className="notfound container">
      <div>
        <p className="eyebrow">404</p>
        <h1>That page does not exist.</h1>
        <p className="lead" style={{ margin: "16px auto 24px" }}>
          Try the home page instead.
        </p>
        <Link className="btn btn-primary" to="/">
          Go home
        </Link>
      </div>
    </section>
  );
}
