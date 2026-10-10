import { FeatureIcon, IconArrow, IconGitHub } from "../components/Icons";
import { Picture } from "../components/Picture";
import { APP_URL, FEATURES, GITHUB_URL, INTEGRATIONS } from "../content/site";
import front800 from "../media/speaker-front-800.webp";
import front1600 from "../media/speaker-front-1600.webp";
import hero800 from "../media/speaker-hero-800.webp";
import hero1600 from "../media/speaker-hero-1600.webp";
import top800 from "../media/speaker-top-800.webp";
import top1600 from "../media/speaker-top-1600.webp";

export function Home() {
  return (
    <>
      <section className="hero">
        <div className="hero-glow" aria-hidden="true" />
        <div className="container hero-inner">
          <div className="hero-copy animate-in">
            <p className="eyebrow">Open-source home assistant speaker</p>
            <h1>
              A speaker that listens to you.
              <span className="serif">Not to a company.</span>
            </h1>
            <p className="lead">
              Alexsay is a voice assistant you build and own. A Raspberry Pi 5, a four-microphone array, the AI provider
              you choose on your own key, and a smart home that keeps working offline.
            </p>
            <div className="hero-actions">
              <a className="btn btn-primary btn-lg" href={APP_URL}>
                Open the app <IconArrow />
              </a>
              <a className="btn btn-secondary btn-lg" href={GITHUB_URL}>
                <IconGitHub /> Build one
              </a>
            </div>
            <p className="hero-note">Hardware, firmware and this site are open. Your API keys stay yours.</p>
          </div>
          <div className="hero-media animate-in">
            <Picture
              large={hero1600}
              small={hero800}
              alt="The Alexsay speaker: a charcoal fabric cylinder with a softly glowing top"
              width={1600}
              height={900}
              eager
              className="hero-render"
            />
          </div>
        </div>
      </section>

      <section className="section" id="features">
        <div className="container">
          <div className="section-head">
            <h2>Built for conversation, not commands.</h2>
            <p className="lead">Everything that makes a speaker pleasant to talk to, with nothing hidden inside.</p>
          </div>
          <div className="features">
            {FEATURES.map((feature) => (
              <article key={feature.title} className="card feature">
                <div className="feature-icon">
                  <FeatureIcon name={feature.icon} />
                </div>
                <h3>{feature.title}</h3>
                <p>{feature.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section-tight" id="integrations">
        <div className="container">
          <div className="section-head">
            <h2>Plugs into what you already use.</h2>
            <p className="lead">
              Pick an AI provider for the conversation and the smart home it should control. More providers are on the
              way.
            </p>
          </div>
          <div className="integrations">
            {INTEGRATIONS.map((integration) => (
              <div key={integration.name} className="integration">
                <span className="integration-badge" style={{ background: integration.hue }}>
                  {integration.initials}
                </span>
                <span>
                  {integration.name}
                  <small>{integration.note}</small>
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="hardware">
        <div className="container">
          <div className="section-head">
            <h2>
              Hear it. <span className="serif">See it listening.</span>
            </h2>
            <p className="lead">
              A seamless fabric wrap around a 4 inch driver, a glass top that glows while a conversation is open.
            </p>
          </div>
          <div className="renders">
            <figure className="card render render-light">
              <Picture
                large={front1600}
                small={front800}
                alt="The Alexsay speaker in light grey fabric, seen from the front"
                width={1600}
                height={900}
              />
              <figcaption>Light fabric, front view</figcaption>
            </figure>
            <figure className="card render render-dark">
              <Picture
                large={top1600}
                small={top800}
                alt="The Alexsay speaker from above, its top glowing while it listens"
                width={1600}
                height={900}
              />
              <figcaption>The top lights up while it listens</figcaption>
            </figure>
          </div>
        </div>
      </section>

      <section className="section cta" id="open-source">
        <div className="container cta-inner">
          <h2>
            Open hardware. <span className="serif">Open source.</span>
          </h2>
          <p className="lead">
            The parts list, the printed enclosure, the Rust daemon, the app and this website live in one repository.
            Read it, build it, change it.
          </p>
          <div className="hero-actions">
            <a className="btn btn-primary btn-lg" href={GITHUB_URL}>
              <IconGitHub /> View on GitHub
            </a>
            <a className="btn btn-secondary btn-lg" href={APP_URL}>
              Open the app
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
