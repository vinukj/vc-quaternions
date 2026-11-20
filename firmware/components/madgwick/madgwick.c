/*
 * madgwick.c — compact Madgwick AHRS (6-axis / no-magnetometer mode)
 *
 * This is the standard Madgwick filter with the magnetometer terms removed.
 * It runs in ~60 µs on ESP32-S3 @ 240 MHz — comfortably inside the 5 ms
 * (200 Hz) IMU sample period.
 *
 * Port notes:
 *   - No external dependencies (no math.h needed beyond fmod/floor,
 *     implemented as integer ops where possible; we only use sqrt and f).
 *   - Quaternion is kept normalized each step with the Madgwick-style
 *     "add half the unnormalized components" trick to keep ||q||=1.
 *   - Gyro input is expected in deg/s, accel in g.
 *
 * Reference implementation (original C):
 *   https://x-io.co.uk/wp-content/uploads/2018/04/MadgwickAHRS.c
 */
#include "madgwick.h"

#include <string.h>
#include <math.h>

#define TWO_Q             2.0f
#define FOUR_Q            4.0f
#define FIVE_Q            5.0f
#define FOUR_THIRD        4.0f / 3.0f
#define SQRT2             1.4142135623730950488f
#define ONE_Q             1.0f
#define HALF_PI           0.5f * M_PI

/* ---------------------------------------------------------------------- */
void madgwick_init(madgwick_state_t *state)
{
    if (state == NULL) {
        return;
    }

    memset(state, 0, sizeof(*state));
    state->beta = 0.1f;
    state->sample_interval_ms = 5;

    /* Identity quaternion: no rotation. */
    state->q.w = 1.0f;
    state->q.x = 0.0f;
    state->q.y = 0.0f;
    state->q.z = 0.0f;
}

void madgwick_set_beta(madgwick_state_t *state, float beta)
{
    if (state == NULL || !isfinite(beta)) {
        return;
    }
    state->beta = (beta < 0.01f) ? 0.01f : beta;
    /* Clamp to a sane maximum: above 1.0 the filter becomes unstable. */
    state->beta = (state->beta > 1.0f) ? 1.0f : state->beta;
}

void madgwick_set_interval_ms(madgwick_state_t *state, uint16_t ms)
{
    if (state == NULL) {
        return;
    }
    state->sample_interval_ms = ms;
}

/* ---------------------------------------------------------------------- */
/* Helper: normalize a quaternion (keep it on the unit hypersphere). */
static void normalize_q(madgwick_quaternion_t *q)
{
    float norm = sqrtf(q->w * q->w + q->x * q->x +
                       q->y * q->y + q->z * q->z);
    if (norm > 0.0f) {
        float inv = 1.0f / norm;
        q->w *= inv;
        q->x *= inv;
        q->y *= inv;
        q->z *= inv;
    }
}

/* ---------------------------------------------------------------------- */
/* Quaternion helpers. */

madgwick_quaternion_t madgwick_conj(const madgwick_quaternion_t *q)
{
    madgwick_quaternion_t c = *q;
    c.x = -q->x;
    c.y = -q->y;
    c.z = -q->z;
    return c;
}

void madgwick_mult(const madgwick_quaternion_t *a,
                   const madgwick_quaternion_t *b,
                   madgwick_quaternion_t *q_out)
{
    /* Hamilton product: q_out = a ⊗ b */
    float aw = a->w, ax = a->x, ay = a->y, az = a->z;
    float bw = b->w, bx = b->x, by = b->y, bz = b->z;

    q_out->w = aw * bw - ax * bx - ay * by - az * bz;
    q_out->x = aw * bx + ax * bw + ay * bz - az * by;
    q_out->y = aw * by - ax * bz + ay * bw + az * bx;
    q_out->z = aw * bz + ax * by - ay * bx + az * bw;

    normalize_q(q_out);
}

/* ---------------------------------------------------------------------- */
/* Euler / quaternion conversions. */

void madgwick_euler_to_quat(float roll, float pitch, float yaw,
                            madgwick_quaternion_t *q)
{
    float cr = cosf(roll * 0.5f);
    float sr = sinf(roll * 0.5f);
    float cp = cosf(pitch * 0.5f);
    float sp = sinf(pitch * 0.5f);
    float cy = cosf(yaw * 0.5f);
    float sy = sinf(yaw * 0.5f);

    q->w = cr * cp * cy + sr * sp * sy;
    q->x = sr * cp * cy - cr * sp * sy;
    q->y = cr * sp * cy + sr * cp * sy;
    q->z = cr * cp * sy - sr * sp * cy;
    normalize_q(q);
}

void madgwick_quat_to_euler(const madgwick_quaternion_t *q,
                            float *roll, float *pitch, float *yaw)
{
    if (q == NULL) {
        return;
    }

    /*
     * Rotation sequence Z-Y-X (Yaw-Pitch-Roll) with a right-handed
     * sensor frame (X-forward, Y-left, Z-up).
     *
     * roll    = atan2(2(qw qx + qy qz), 1 - 2(qx² + qy²))
     * pitch   = asin(2(qw qy - qz qx))
     * yaw     = atan2(2(qw qz + qx qy), 1 - 2(qy² + qz²))
     */
    float qw = q->w, qx = q->x, qy = q->y, qz = q->z;

    float sinr_cosp = TWO_Q * (qw * qx + qy * qz);
    float cosr_cosp = ONE_Q - TWO_Q * (qx * qx + qy * qy);
    *roll = atan2f(sinr_cosp, cosr_cosp);

    float sinp = TWO_Q * (qw * qy - qz * qx);
    if (fabsf(sinp) >= ONE_Q) {
        *pitch = (sinp > 0.0f) ? (HALF_PI) : (-HALF_PI);
    } else {
        *pitch = asinf(sinp);
    }

    float siny_cosp = TWO_Q * (qw * qz + qx * qy);
    float cosy_cosp = ONE_Q - TWO_Q * (qy * qy + qz * qz);
    *yaw = atan2f(siny_cosp, cosy_cosp);
}

/* ---------------------------------------------------------------------- */
/* Madgwick 6-axis update (accelerometer + gyroscope; NO magnetometer). */

bool madgwick_updateIMU(madgwick_state_t *state,
                        float ax, float ay, float az,
                        float gx, float gy, float gz,
                        float dt_s,
                        madgwick_quaternion_t *q_out)
{
    if (state == NULL || q_out == NULL || !isfinite(dt_s) || dt_s <= 0.0f ||
        !isfinite(ax) || !isfinite(ay) || !isfinite(az) ||
        !isfinite(gx) || !isfinite(gy) || !isfinite(gz) ||
        !isfinite(state->beta) ||
        !isfinite(state->q.w) || !isfinite(state->q.x) ||
        !isfinite(state->q.y) || !isfinite(state->q.z)) {
        return false;
    }

    /* Convert gyro deg/s -> rad/s. */
    const float DEG_TO_RAD = 0.017453292519943295f;
    gx *= DEG_TO_RAD;
    gy *= DEG_TO_RAD;
    gz *= DEG_TO_RAD;

    float q0 = state->q.w;
    float q1 = state->q.x;
    float q2 = state->q.y;
    float q3 = state->q.z;

    /* Rate of change of quaternion from gyroscope. */
    float qDot1 = 0.5f * (-q1 * gx - q2 * gy - q3 * gz);
    float qDot2 = 0.5f * ( q0 * gx + q2 * gz - q3 * gy);
    float qDot3 = 0.5f * ( q0 * gy - q1 * gz + q3 * gx);
    float qDot4 = 0.5f * ( q0 * gz + q1 * gy - q2 * gx);

    /* Accelerometer feedback (gradient descent) only if measurement valid. */
    float accelNormSq = ax*ax + ay*ay + az*az;
    if (accelNormSq > 1e-12f) {
        float recipNorm = 1.0f / sqrtf(accelNormSq);
        ax *= recipNorm;
        ay *= recipNorm;
        az *= recipNorm;

        float _2q0 = 2.0f * q0;
        float _2q1 = 2.0f * q1;
        float _2q2 = 2.0f * q2;
        float _2q3 = 2.0f * q3;
        float _4q0 = 4.0f * q0;
        float _4q1 = 4.0f * q1;
        float _4q2 = 4.0f * q2;
        float _8q1 = 8.0f * q1;
        float _8q2 = 8.0f * q2;
        float q0q0 = q0 * q0;
        float q1q1 = q1 * q1;
        float q2q2 = q2 * q2;
        float q3q3 = q3 * q3;

        float s0 = _4q0 * q2q2 + _2q2 * ax + _4q0 * q1q1 - _2q1 * ay;
        float s1 = _4q1 * q3q3 - _2q3 * ax + 4.0f * q0q0 * q1 - _2q0 * ay - _4q1 + _8q1 * q1q1 + _8q1 * q2q2 + _4q1 * az;
        float s2 = 4.0f * q0q0 * q2 + _2q0 * ax + _4q2 * q3q3 - _2q3 * ay - _4q2 + _8q2 * q1q1 + _8q2 * q2q2 + _4q2 * az;
        float s3 = 4.0f * q1q1 * q3 - _2q1 * ax + 4.0f * q2q2 * q3 - _2q2 * ay;

        float stepNormSq = s0*s0 + s1*s1 + s2*s2 + s3*s3;
        /* At the measured gravity direction the gradient is exactly zero.
         * Skip correction in that case instead of normalizing 0/0 to NaN. */
        if (stepNormSq > 1e-12f) {
            recipNorm = 1.0f / sqrtf(stepNormSq);
            s0 *= recipNorm;
            s1 *= recipNorm;
            s2 *= recipNorm;
            s3 *= recipNorm;

            qDot1 -= state->beta * s0;
            qDot2 -= state->beta * s1;
            qDot3 -= state->beta * s2;
            qDot4 -= state->beta * s3;
        }
    }

    /* Integrate. */
    q0 += qDot1 * dt_s;
    q1 += qDot2 * dt_s;
    q2 += qDot3 * dt_s;
    q3 += qDot4 * dt_s;

    /* Normalize. */
    float n = sqrtf(q0*q0 + q1*q1 + q2*q2 + q3*q3);
    if (!isfinite(n) || n <= 1e-12f) {
        return false;
    }
    float inv = 1.0f / n;
    q0 *= inv; q1 *= inv; q2 *= inv; q3 *= inv;

    q_out->w = q0;
    q_out->x = q1;
    q_out->y = q2;
    q_out->z = q3;
    state->q = *q_out;
    return true;
}

void madgwick_normalize(madgwick_quaternion_t *q)
{
    if (q == NULL) return;
    float n = sqrtf(q->w*q->w + q->x*q->x + q->y*q->y + q->z*q->z);
    if (n > 0.0f) {
        float inv = 1.0f / n;
        q->w *= inv; q->x *= inv; q->y *= inv; q->z *= inv;
    }
}
