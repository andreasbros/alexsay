//! G.711 mu-law, the format of a Twilio media stream, and the 8 kHz to 16 kHz steps around it.

const BIAS: i32 = 0x84;
const CLIP: i32 = 32_635;

/// One 16-bit sample to mu-law, the ITU G.711 way.
pub fn encode_sample(sample: i16) -> u8 {
    let mut pcm = i32::from(sample);
    let sign = if pcm < 0 {
        pcm = -pcm;
        0x80
    } else {
        0
    };
    pcm = pcm.min(CLIP) + BIAS;
    let mut exponent = 7;
    let mut mask = 0x4000;
    while exponent > 0 && pcm & mask == 0 {
        exponent -= 1;
        mask >>= 1;
    }
    let mantissa = (pcm >> (exponent + 3)) & 0x0F;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let byte = !(sign | (exponent << 4) | mantissa) as u8;
    byte
}

pub fn decode_sample(byte: u8) -> i16 {
    let value = i32::from(!byte);
    let sign = value & 0x80;
    let exponent = (value >> 4) & 0x07;
    let mantissa = value & 0x0F;
    let mut pcm = ((mantissa << 3) + BIAS) << exponent;
    pcm -= BIAS;
    #[allow(clippy::cast_possible_truncation)]
    let sample = if sign != 0 { -pcm } else { pcm } as i16;
    sample
}

pub fn encode(samples: &[i16]) -> Vec<u8> {
    samples.iter().map(|&s| encode_sample(s)).collect()
}

pub fn decode(bytes: &[u8]) -> Vec<i16> {
    bytes.iter().map(|&b| decode_sample(b)).collect()
}

/// 16 kHz to 8 kHz: a two-tap average, which also damps what would alias.
pub fn halve(samples: &[i16]) -> Vec<i16> {
    samples
        .chunks(2)
        .map(|pair| {
            let sum: i32 = pair.iter().map(|&s| i32::from(s)).sum();
            let count = i32::try_from(pair.len()).unwrap_or(1);
            #[allow(clippy::cast_possible_truncation)]
            let avg = (sum / count) as i16;
            avg
        })
        .collect()
}

/// 8 kHz to 16 kHz by linear interpolation; the last sample is held.
pub fn double(samples: &[i16]) -> Vec<i16> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for (i, &s) in samples.iter().enumerate() {
        let next = samples.get(i + 1).copied().unwrap_or(s);
        out.push(s);
        #[allow(clippy::cast_possible_truncation)]
        let mid = i32::midpoint(i32::from(s), i32::from(next)) as i16;
        out.push(mid);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mulaw_round_trips_within_quantisation() {
        for &sample in &[
            0i16, 1, -1, 100, -100, 1000, -1000, 12_345, -12_345, 32_000, -32_000,
        ] {
            let back = decode_sample(encode_sample(sample));
            let error = (i32::from(back) - i32::from(sample)).abs();
            let step = (i32::from(sample).abs() / 16).max(8);
            assert!(error <= step, "{sample} -> {back}");
        }
        assert_eq!(encode_sample(0), 0xFF);
        assert_eq!(decode(&encode(&[0, 500, -500])).len(), 3);
    }

    #[test]
    fn rate_steps_keep_the_length_ratio() {
        let wave: Vec<i16> = (0..320).map(|i| (i % 40) as i16 * 100).collect();
        let low = halve(&wave);
        assert_eq!(low.len(), 160);
        let high = double(&low);
        assert_eq!(high.len(), 320);
        assert_eq!(halve(&[10, 20, 30]), vec![15, 30]);
        assert_eq!(double(&[0, 100]), vec![0, 50, 100, 100]);
    }
}
