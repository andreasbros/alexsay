import { FeatureIcon, IconArrow, IconGitHub } from "../components/Icons";
import { ThemedPicture } from "../components/ThemedPicture";
import { APP_URL, FEATURES, GITHUB_URL, INTEGRATIONS } from "../content/site";
import dayTall600 from "../media/home-day-tall-600.webp";
import dayTall1200 from "../media/home-day-tall-1200.webp";
import dayWide800 from "../media/home-day-wide-800.webp";
import dayWide1600 from "../media/home-day-wide-1600.webp";
import nightTall600 from "../media/home-night-tall-600.webp";
import nightTall1200 from "../media/home-night-tall-1200.webp";
import nightWide800 from "../media/home-night-wide-800.webp";
import nightWide1600 from "../media/home-night-wide-1600.webp";

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
              <span className="serif">On your terms.</span>
            </h1>
            <p className="lead">
              Alexsay is a voice assistant you build and own: a Raspberry Pi 5, a four-microphone array and the AI
              provider you choose, on your own key.
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
            <ThemedPicture
              night={{ large: nightWide1600, small: nightWide800 }}
              day={{ large: dayWide1600, small: dayWide800 }}
              alt="The Alexsay speaker, a charcoal fabric cylinder, on a wooden side table at home"
              width={1600}
              height={900}
              eager
              className="hero-photo"
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
        <div className="container hardware">
          <div className="hardware-copy">
            <h2>
              Made to be heard, <span className="serif">not looked at.</span>
            </h2>
            <p className="lead">
              A seamless fabric wrap around a 4 inch driver, a four-microphone array under the top. No screen, no
              buttons: you talk to it, and it talks back.
            </p>
            <ul className="ticks">
              <li>Raspberry Pi 5 inside</li>
              <li>Hardware echo cancellation</li>
              <li>3D-printed enclosure</li>
              <li>Mains powered, one cable</li>
            </ul>
          </div>
          <figure className="card photo">
            <ThemedPicture
              night={{ large: nightTall1200, small: nightTall600 }}
              day={{ large: dayTall1200, small: dayTall600 }}
              alt="The Alexsay speaker on a table in a living room"
              width={1200}
              height={1400}
            />
          </figure>
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
