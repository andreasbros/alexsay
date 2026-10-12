//! Spoken announcements outside a conversation ("updating now", "I can't reach the server") through
//! `OpenAI`'s speech endpoint with the owner's key; PCM16 mono at 24 kHz comes back.

use anyhow::Context;

pub const TTS_RATE: u32 = 24_000;

pub async fn speak(
    base_url: &str,
    api_key: &str,
    voice: &str,
    text: &str,
) -> anyhow::Result<Vec<i16>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .context("building the HTTP client")?;
    let res = client
        .post(format!(
            "{}/audio/speech",
            alexsay_core::live::rest_base(base_url)
        ))
        .bearer_auth(api_key)
        .json(&serde_json::json!({
            "model": "gpt-4o-mini-tts",
            "voice": voice,
            "input": text,
            "response_format": "pcm",
        }))
        .send()
        .await
        .context("asking OpenAI for speech")?;
    anyhow::ensure!(
        res.status().is_success(),
        "speech endpoint answered {}",
        res.status()
    );
    let bytes = res.bytes().await.context("reading the speech")?;
    Ok(bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&pair| i16::from_le_bytes(pair))
        .collect())
}
