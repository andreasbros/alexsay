//! PCM16 helpers: the GPT-Live wire format (base64 little-endian), mixing and levels.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

pub const LIVE_RATE: u32 = 16_000;

pub fn encode(samples: &[i16]) -> String {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    STANDARD.encode(bytes)
}

pub fn encode_bytes(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

pub fn decode_bytes(text: &str) -> Vec<u8> {
    STANDARD.decode(text).unwrap_or_default()
}

pub fn decode(text: &str) -> Vec<i16> {
    let bytes = STANDARD.decode(text).unwrap_or_default();
    bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&pair| i16::from_le_bytes(pair))
        .collect()
}

/// One channel out of interleaved audio, or the average of all of them when none is chosen.
pub fn pick_channel(interleaved: &[f32], channels: usize, channel: Option<usize>) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    match channel {
        Some(index) if index < channels => interleaved
            .chunks_exact(channels)
            .map(|frame| frame[index])
            .collect(),
        _ => interleaved
            .chunks_exact(channels)
            .map(|frame| {
                #[allow(clippy::cast_precision_loss)]
                let count = channels as f32;
                frame.iter().sum::<f32>() / count
            })
            .collect(),
    }
}

pub fn to_i16(samples: &[f32], gain: f32) -> Vec<i16> {
    samples
        .iter()
        .map(|&v| {
            #[allow(clippy::cast_possible_truncation)]
            let sample = ((v * gain).clamp(-1.0, 1.0) * 32767.0) as i16;
            sample
        })
        .collect()
}

pub fn to_f32(samples: &[i16]) -> Vec<f32> {
    samples.iter().map(|&s| f32::from(s) / 32768.0).collect()
}

/// Root mean square of the chunk, 0 to 1, for level meters and the smoke test.
pub fn rms(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f64 = samples
        .iter()
        .map(|&s| (f64::from(s) / 32768.0).powi(2))
        .sum();
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
    let value = (sum / samples.len() as f64).sqrt() as f32;
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips_little_endian() {
        let samples = [0i16, 1, -1, 32_767, -32_768];
        assert_eq!(encode(&[1]), "AQA=");
        assert_eq!(decode(&encode(&samples)), samples);
        assert_eq!(decode("not base64!"), Vec::<i16>::new());
    }

    #[test]
    fn channels_are_picked_or_averaged() {
        let frames = [1.0, 0.0, 0.5, 0.0, 0.0, 1.0];
        assert_eq!(pick_channel(&frames, 3, Some(0)), vec![1.0, 0.0]);
        assert_eq!(pick_channel(&frames, 3, Some(2)), vec![0.5, 1.0]);
        assert_eq!(pick_channel(&frames, 3, Some(9)), vec![0.5, 1.0 / 3.0]);
        assert_eq!(pick_channel(&frames, 1, None), frames.to_vec());
    }

    #[test]
    fn levels_and_conversion() {
        assert_eq!(to_i16(&[0.5, -2.0], 1.0), vec![16_383, -32_767]);
        assert_eq!(to_i16(&[0.25], 2.0), vec![16_383]);
        assert!((rms(&[16_384, -16_384]) - 0.5).abs() < 0.01);
        assert_eq!(rms(&[]), 0.0);
        assert!((to_f32(&[16_384])[0] - 0.5).abs() < 0.001);
    }
}
