/*
 * madgwick.h — Madgwick AHRS filter (no magnetometer / 6-axis IMU mode)
 *
 * Compact, dependency-free port of the original Madgwick & McConnell
 * algorithm, tuned for the QMI8658 on the Waveshare ESP32-S3-LCD-1.28.
 *
 * Usage:
 *   1. madgwick_init()   — set beta, initialize quaternion to identity
 *   2. Loop: madgwick_updateIMU(ax,ay,az, gx,gy,gz, dt)
 *        -> q_out holds w,x,y,z orientation
 *
 * dt: fixed 5 ms (200 Hz) for the IMU sample rate.
 * beta: 0.1 for general motion; reduce to ~0.05 if gyro drift is excessive.
 *
 * Coordinate convention (matches QMI8658 default, Z-up):
 *   X-forward, Y-left, Z-up.
 *   The client (web/Unity) rotates by -90° around X to convert to Y-up
 *   (Three.js/Unity) — firmware stays board-agnostic.
 *
 * References:
 *   - Madgwick et al., "Estimation of IMU and MARG orientation"
 *     https://www.x-io.co.uk/open-source-imu-and-attitude-estimation/
 */
#pragma once

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Orientation as a quaternion: q = w + x*i + y*j + z*k (normalized). */
typedef struct {
    float w;
    float x;
    float y;
    float z;
} madgwick_quaternion_t;

/** Filter state — keep opaque; expose only what the app needs. */
typedef struct {
    madgwick_quaternion_t q;     /* current orientation (normalized) */
    float beta;                  /* gains: 0.1 default */
    uint16_t sample_interval_ms; /* must match IMU rate */
} madgwick_state_t;

/**
 * Initialize the filter.
 * q_out is set to the identity quaternion (no rotation).
 * All fields are initialized to safe defaults: beta=0.1, 5 ms interval.
 */
void madgwick_init(madgwick_state_t *state);

/**
 * Set the gains beta.
 *   0.05  — aggressive drift suppression, slightly laggy
 *   0.10  — default, good for bat swings (±2000 dps)
 *   0.20  — follows fast motion well, drifts more on static periods
 * Call only when the IMU is stationary (or between shots).
 */
void madgwick_set_beta(madgwick_state_t *state, float beta);

/**
 * Set the sample interval (must match the actual IMU sampling period).
 * Default: 5 ms. Update only on reconfiguration.
 */
void madgwick_set_interval_ms(madgwick_state_t *state, uint16_t ms);

/**
 * 6-axis (accelerometer + gyroscope only) Madgwick update.
 * No magnetometer is used — yaw will still drift slowly, which is why
 * "Take Guard" captures a reference orientation and reports relative angles.
 *
 * @param state   filter state
 * @param ax,ay,az accelerometer in g (range ±8 → ±1.0…1.0)
 * @param gx,gy,gz gyroscope in deg/s (range ±2000 → up to ±2048)
 * @param dt_s    sample interval in seconds (fixed 0.005)
 * @param q_out   output quaternion (caller must provide buffer)
 * @return true on success
 */
bool madgwick_updateIMU(madgwick_state_t *state,
                        float ax, float ay, float az,
                        float gx, float gy, float gz,
                        float dt_s,
                        madgwick_quaternion_t *q_out);

/**
 * Normalize a quaternion in place (defensive guard against float drift).
 */
void madgwick_normalize(madgwick_quaternion_t *q);

/**
 * Quaternion conjugate (inverse for unit quaternions).
 */
madgwick_quaternion_t madgwick_conj(const madgwick_quaternion_t *q);

/**
 * q_out = a ⊗ b (Hamilton product).
 * q_out may alias a or b.
 */
void madgwick_mult(const madgwick_quaternion_t *a,
                   const madgwick_quaternion_t *b,
                   madgwick_quaternion_t *q_out);

/**
 * Convert Euler angles (roll, pitch, yaw in radians) → quaternion.
 * Convention: rotate about X, then Y, then Z of the *sensor* frame.
 */
void madgwick_euler_to_quat(float roll, float pitch, float yaw,
                            madgwick_quaternion_t *q);

/**
 * Convert radians → degrees, used by client-side math in web/shot-classifier.js.
 */

/**
 * Extract Euler angles (radians) from a quaternion.
 * Roll/Pitch relative to the current reference frame.
 */
void madgwick_quat_to_euler(const madgwick_quaternion_t *q,
                            float *roll, float *pitch, float *yaw);

/**
 * Convert degrees → radians, used by client-side math in web/shot-classifier.js.
 */
#define DEG2RAD(d)  ((d) * 0.017453292519943295f)
#define RAD2DEG(r)  ((r) * 57.29577951308232f)

#ifdef __cplusplus
}
#endif
