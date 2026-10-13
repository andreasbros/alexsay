candle-core 0.2.2 (rustpotter 3.0.2's dependency) with one change: random f16/bf16 tensors are drawn as
f32 and converted, instead of through `half`'s rand_distr feature. That feature ties `half` to rand 0.8,
which kept `half` at 2.3.1; tract (livekit-wakeword's ONNX backend) needs a newer `half`, and Cargo
allows one `half` 2.x per build. rustpotter only uses f32, so the change is never exercised.

`src/lib.rs` also allows all warnings: as a path dependency it is linted like workspace code, and its own
warnings are not ours to fix.
