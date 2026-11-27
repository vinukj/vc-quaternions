/*
 * ble_server.c — NimBLE GATT server (cricket bat tracker)
 */
#include "ble_server.h"

#include <stdio.h>
#include <string.h>
#include <math.h>

#include "esp_log.h"
#include "esp_mac.h"
#include "esp_system.h"
#include "imu_bluetooth_task.h"
#include "shot_state_transition.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

/* NimBLE (ESP-IDF 5.x/6.x) */
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/ble_store.h"
#include "host/util/util.h"
#include "host/ble_att.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#define TAG "BLE"

/* ---------------------------------------------------------------------- */
/* UUIDs — NimBLE uses 128-bit UUIDs in **little-endian** byte order.
 *
 * Service string  : 12345678-1234-1234-1234-123456789abc
 *   → BE bytes    : 12 34 56 78  34 12  34 12  34 12  34 12 78 56 34 12
 *   → LE bytes    : ab 90 78 56  34 12  34 12  34 12  34 12 78 56 34 12
 *
 * Notify string   : 12345678-1234-1234-1234-123456789abd
 *   → LE bytes    : bd 90 78 56  34 12  34 12  34 12  34 12 78 56 34 12
 *
 * Command string  : 12345678-1234-1234-1234-123456789abe
 *   → LE bytes    : be 90 78 56  34 12  34 12  34 12  34 12 78 56 34 12
 */

static const ble_uuid128_t svc_uuid =
    BLE_UUID128_INIT(0xbc, 0x9a, 0x78, 0x56,
                     0x34, 0x12, 0x34, 0x12,
                     0x34, 0x12, 0x34, 0x12,
                     0x78, 0x56, 0x34, 0x12);

static const ble_uuid128_t chr_notify_uuid =
    BLE_UUID128_INIT(0xbd, 0x9a, 0x78, 0x56,
                     0x34, 0x12, 0x34, 0x12,
                     0x34, 0x12, 0x34, 0x12,
                     0x78, 0x56, 0x34, 0x12);

static const ble_uuid128_t chr_cmd_uuid =
    BLE_UUID128_INIT(0xbe, 0x9a, 0x78, 0x56,
                     0x34, 0x12, 0x34, 0x12,
                     0x34, 0x12, 0x34, 0x12,
                     0x78, 0x56, 0x34, 0x12);

static const ble_uuid128_t chr_state_uuid =
    BLE_UUID128_INIT(0xbf, 0x9a, 0x78, 0x56,
                     0x34, 0x12, 0x34, 0x12,
                     0x34, 0x12, 0x34, 0x12,
                     0x78, 0x56, 0x34, 0x12);

/* ---------------------------------------------------------------------- */
/* Payload layout (17 bytes, LE float32) — vc.md spec. */

#define NOTIFY_PAYLOAD_SIZE  17U
#define CONFIG_PAYLOAD_SIZE  8U
#define STATE_PAYLOAD_SIZE   26U
#define CONFIG_MAGIC         0xA1U
#define CONFIG_VERSION       1U

typedef struct {
    uint8_t  data[NOTIFY_PAYLOAD_SIZE];
} ble_notify_packet_t;

static_assert(NOTIFY_PAYLOAD_SIZE == 17, "payload must be 17 bytes");

/* ---------------------------------------------------------------------- */
/* State. */

static volatile uint16_t s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
static uint16_t s_chr_notify_handle;
static uint16_t s_chr_cmd_handle;
static uint16_t s_chr_state_handle;
static uint8_t s_own_addr_type;
static bool s_streaming;
static uint32_t s_shot_state;
static uint8_t s_sensor_reset_status;
static bool s_sensor_reset_command_accepted;

/* Last sent packet (also returned on READ for backward-compat). */
static ble_notify_packet_t s_last_packet;
static SemaphoreHandle_t s_notify_lock;

/* Guard/reference frame (for "Take Guard"). */
static madgwick_quaternion_t s_guard_q = {1.0f, 0.0f, 0.0f, 0.0f};
static bool s_guard_active = false;

/* Browser-owned game settings are acknowledged here but shot timing and game
 * outcomes remain client-side. The capture window is reported for audit and
 * synchronization; the fixed-rate IMU stream is not altered. */
static bool s_config_accepted;
static uint8_t s_config_sequence;
static uint8_t s_difficulty;
static uint8_t s_bowled_probability = 3;
static uint8_t s_edge_probability = 10;
static uint16_t s_capture_window_ms = 525;
/* Sampling cadence: how often quaternions are sent over BLE (IMU fusion stays
 * at 200 Hz). sampcnt 1..4 -> notify every 4th/3rd/2nd/1st sample. */
static uint8_t s_sampcnt = 1;

/* Device identity. */
static char s_device_name[32] = "CricketBat";
static char s_device_id[12] = "";   /* "AA:BB:CC:DD" */

/* Public API. */
const char *ble_server_get_device_name(void) { return s_device_name; }
const char *ble_server_get_device_id(void)    { return s_device_id; }

uint16_t ble_server_get_conn_handle(void)
{
    return __atomic_load_n(&s_conn_handle, __ATOMIC_ACQUIRE);
}

bool ble_server_is_connected(void)
{
    return ble_server_get_conn_handle() != BLE_HS_CONN_HANDLE_NONE;
}

bool ble_server_is_streaming(void)
{
    return __atomic_load_n(&s_streaming, __ATOMIC_ACQUIRE);
}

uint8_t ble_server_get_notify_skip(void)
{
    return shot_state_sampcnt_to_skip(s_sampcnt);
}

ble_shot_state_t ble_server_get_shot_state(void)
{
    return (ble_shot_state_t)__atomic_load_n(&s_shot_state, __ATOMIC_ACQUIRE);
}

bool ble_server_is_start_ready(void)
{
    if (!ble_server_is_connected() || !ble_server_is_streaming()) return false;
    if (!s_notify_lock || xSemaphoreTake(s_notify_lock, portMAX_DELAY) != pdTRUE) return false;
    const bool session_ready = s_config_accepted && s_guard_active;
    xSemaphoreGive(s_notify_lock);
    return session_ready && ble_server_get_shot_state() == BLE_SHOT_READY;
}

void ble_server_set_sensor_reset_result(bool succeeded)
{
    if (!s_notify_lock || xSemaphoreTake(s_notify_lock, portMAX_DELAY) != pdTRUE) {
        ESP_LOGE(TAG, "Cannot publish IMU reset result: BLE state lock unavailable");
        return;
    }
    shot_sensor_reset_result(&s_sensor_reset_status, succeeded);
    if (!succeeded) s_sensor_reset_command_accepted = false;
    xSemaphoreGive(s_notify_lock);
}

bool ble_server_request_shot_start(void)
{
    if (!ble_server_is_start_ready()) return false;
    uint32_t expected = BLE_SHOT_READY;
    return __atomic_compare_exchange_n(&s_shot_state, &expected,
                                       BLE_SHOT_START_REQUESTED, false,
                                       __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE);
}

/* ---------------------------------------------------------------------- */
/* Packet construction. */

static void build_packet(const madgwick_quaternion_t *q, uint8_t flags,
                         ble_notify_packet_t *out)
{
    /* Little-endian float32 packing (same as client-side getFloat32(true)). */
    uint8_t *p = out->data;
    union { float f; uint8_t b[4]; } u;

    u.f = q->w; memcpy(p + 0, u.b, 4);
    u.f = q->x; memcpy(p + 4, u.b, 4);
    u.f = q->y; memcpy(p + 8, u.b, 4);
    u.f = q->z; memcpy(p + 12, u.b, 4);
    p[16] = flags;
}

/* ---------------------------------------------------------------------- */
/* GATT access callbacks. */

static int notify_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                            struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

    if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) {
        return BLE_ATT_ERR_READ_NOT_PERMITTED;
    }

    if (!s_notify_lock ||
        xSemaphoreTake(s_notify_lock, portMAX_DELAY) != pdTRUE) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    int rc = os_mbuf_append(ctxt->om, s_last_packet.data,
                            sizeof(s_last_packet.data));
    xSemaphoreGive(s_notify_lock);
    return (rc == 0) ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static void write_le16(uint8_t *destination, uint16_t value)
{
    destination[0] = (uint8_t)(value & 0xffU);
    destination[1] = (uint8_t)(value >> 8);
}

static void write_le_float(uint8_t *destination, float value)
{
    uint32_t bits;
    memcpy(&bits, &value, sizeof(bits));
    destination[0] = (uint8_t)(bits & 0xffU);
    destination[1] = (uint8_t)((bits >> 8) & 0xffU);
    destination[2] = (uint8_t)((bits >> 16) & 0xffU);
    destination[3] = (uint8_t)((bits >> 24) & 0xffU);
}

static int state_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                           struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) return BLE_ATT_ERR_READ_NOT_PERMITTED;
    if (!s_notify_lock || xSemaphoreTake(s_notify_lock, portMAX_DELAY) != pdTRUE) {
        return BLE_ATT_ERR_UNLIKELY;
    }

    uint8_t state[STATE_PAYLOAD_SIZE] = {0};
    state[0] = CONFIG_MAGIC;
    state[1] = CONFIG_VERSION;
    state[2] = s_config_sequence;
    state[3] = (s_config_accepted ? 0x01U : 0U) | (s_guard_active ? 0x02U : 0U);
    state[4] = s_difficulty;
    state[5] = s_bowled_probability;
    state[6] = s_edge_probability;
    write_le16(state + 7, s_capture_window_ms);
    state[9] = shot_state_pack_status(
        ble_server_get_shot_state(), s_sensor_reset_status, s_sampcnt);
    write_le_float(state + 10, s_guard_q.w);
    write_le_float(state + 14, s_guard_q.x);
    write_le_float(state + 18, s_guard_q.y);
    write_le_float(state + 22, s_guard_q.z);
    xSemaphoreGive(s_notify_lock);

    int rc = os_mbuf_append(ctxt->om, state, sizeof(state));
    return rc == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static bool supported_capture_window(uint16_t milliseconds)
{
    switch (milliseconds) {
    case 400: case 500: case 525: case 600: case 700: case 800: case 900:
        return true;
    default:
        return false;
    }
}

static int accept_config_frame(const uint8_t *frame, uint16_t length)
{
    if (length != CONFIG_PAYLOAD_SIZE) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    const uint16_t capture_window = (uint16_t)frame[6] | ((uint16_t)frame[7] << 8);
    if (frame[0] != CONFIG_MAGIC || frame[1] != CONFIG_VERSION || frame[3] > 2 ||
        frame[4] > 100 || frame[5] > 100 || (unsigned)frame[4] + frame[5] > 100 ||
        !supported_capture_window(capture_window)) {
        ESP_LOGW(TAG, "Rejected invalid game config frame");
        return BLE_ATT_ERR_UNLIKELY;
    }

    if (!s_notify_lock || xSemaphoreTake(s_notify_lock, portMAX_DELAY) != pdTRUE) return BLE_ATT_ERR_UNLIKELY;
    const bool config_changed = s_difficulty != frame[3] ||
        s_bowled_probability != frame[4] || s_edge_probability != frame[5] ||
        s_capture_window_ms != capture_window;
    if (config_changed) {
        /* A stance is relative to the setup in which the session was calibrated. */
        s_guard_q = (madgwick_quaternion_t){1.0f, 0.0f, 0.0f, 0.0f};
        s_guard_active = false;
    }
    s_config_sequence = frame[2];
    s_difficulty = frame[3];
    s_bowled_probability = frame[4];
    s_edge_probability = frame[5];
    s_capture_window_ms = capture_window;
    s_config_accepted = true;
    xSemaphoreGive(s_notify_lock);
    ESP_LOGI(TAG, "Game config accepted seq=%u pitch=%u bowled=%u edge=%u capture=%u ms",
             frame[2], frame[3], frame[4], frame[5], capture_window);
    return 0;
}

static int accept_sampcnt(uint8_t sampcnt)
{
    if (sampcnt < 1 || sampcnt > 4) {
        ESP_LOGW(TAG, "Rejected invalid sampcnt %u (expected 1..4)", (unsigned)sampcnt);
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    if (!s_notify_lock || xSemaphoreTake(s_notify_lock, portMAX_DELAY) != pdTRUE) return BLE_ATT_ERR_UNLIKELY;
    s_sampcnt = sampcnt;
    xSemaphoreGive(s_notify_lock);
    ESP_LOGI(TAG, "Sampling cadence accepted: sampcnt=%u -> notify every %u sample(s)",
             (unsigned)sampcnt, (unsigned)shot_state_sampcnt_to_skip(sampcnt));
    return 0;
}

static int cmd_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                         struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return 0;
    }

    uint8_t buf[512] = {0};
    uint16_t len = 0;
    if (ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf) - 1, &len) != 0) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    buf[len] = '\0';

    if (len == 0) {
        return 0;
    }

    if (len == CONFIG_PAYLOAD_SIZE && buf[0] == CONFIG_MAGIC) {
        return accept_config_frame(buf, len);
    }
    if (len == 2 && buf[0] == 0x0B) {
        return accept_sampcnt(buf[1]);
    }
    if (len != 1) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;

    ESP_LOGI(TAG, "Command received: 0x%02X (%zu bytes)", buf[0], (size_t)len);
    const esp_err_t result = ble_server_handle_command(buf[0]);
    return result == ESP_OK ? 0 : BLE_ATT_ERR_UNLIKELY;
}

/* ---------------------------------------------------------------------- */
/* GATT service table. */

static const struct ble_gatt_svc_def s_gatt_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &svc_uuid.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            {
                .uuid      = &chr_notify_uuid.u,
                .access_cb = notify_access_cb,
                .val_handle = &s_chr_notify_handle,
                .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
            },
            {
                .uuid      = &chr_cmd_uuid.u,
                .access_cb = cmd_access_cb,
                .val_handle = &s_chr_cmd_handle,
                .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP,
            },
            {
                .uuid       = &chr_state_uuid.u,
                .access_cb  = state_access_cb,
                .val_handle = &s_chr_state_handle,
                .flags      = BLE_GATT_CHR_F_READ,
            },
            { 0 }   /* sentinel */
        },
    },
    { 0 }   /* sentinel */
};

/* ---------------------------------------------------------------------- */
/* GAP event handler. */

static int gap_event_cb(struct ble_gap_event *event, void *arg);

static void request_reliable_phy(uint16_t conn_handle)
{
    int rc = ble_gap_set_prefered_le_phy(conn_handle,
                                         BLE_GAP_LE_PHY_1M_MASK,
                                         BLE_GAP_LE_PHY_1M_MASK,
                                         0);
    if (rc != 0) {
        ESP_LOGW(TAG, "1M PHY preference unavailable (rc=%d)", rc);
    }
}

static void start_advertising(void)
{
    struct ble_hs_adv_fields fields = {0};
    fields.flags            = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    /* Put the complete name in the primary packet. Edge/Web Bluetooth on
     * macOS is more consistent with namePrefix filters when the name does
     * not depend on the active-scan response. The name + flags fit in the
     * 31-byte legacy payload; keep our 128-bit UUID in the response. */
    fields.name             = (const uint8_t *)s_device_name;
    fields.name_len         = (uint8_t)strlen(s_device_name);
    fields.name_is_complete = 1;

    int rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv_set_fields failed: %d", rc);
        return;
    }

    /* Return the service UUID to scanners that also inspect scan responses. */
    struct ble_hs_adv_fields rsp = {0};
    rsp.uuids128             = (ble_uuid128_t *)&svc_uuid;
    rsp.num_uuids128         = 1;
    rsp.uuids128_is_complete = 1;
    rc = ble_gap_adv_rsp_set_fields(&rsp);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv_rsp_set_fields failed: %d", rc);
        esp_restart();
        return;
    }

    struct ble_gap_adv_params adv_params = {0};
    adv_params.conn_mode = BLE_GAP_CONN_MODE_UND;
    adv_params.disc_mode = BLE_GAP_DISC_MODE_GEN;

    rc = ble_gap_adv_start(s_own_addr_type, NULL, BLE_HS_FOREVER,
                           &adv_params, gap_event_cb, NULL);
    if (rc == 0) {
        ESP_LOGI(TAG, "Advertising as '%s'", s_device_name);
    } else if (rc == BLE_HS_EALREADY) {
        ESP_LOGI(TAG, "Already advertising as '%s'", s_device_name);
    } else {
        ESP_LOGE(TAG, "adv_start failed: %d", rc);
        esp_restart();
    }
}

void ble_server_stop_advertising(void)
{
    int rc = ble_gap_adv_stop();
    if (rc != 0 && rc != BLE_HS_EALREADY) {
        ESP_LOGE(TAG, "adv_stop failed: %d", rc);
    }
}

void ble_server_start_advertising(void)
{
    if (ble_server_is_connected()) {
        ESP_LOGI(TAG, "advertising while connected — ignored");
        return;
    }
    start_advertising();
}

static int gap_event_cb(struct ble_gap_event *event, void *arg)
{
    (void)arg;

    switch (event->type) {

    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            __atomic_store_n(&s_conn_handle, event->connect.conn_handle,
                             __ATOMIC_RELEASE);
            /* The browser subscribes and starts notifications after connect. */
            __atomic_store_n(&s_streaming, false, __ATOMIC_RELEASE);
            __atomic_store_n(&s_shot_state, BLE_SHOT_READY, __ATOMIC_RELEASE);
            if (s_notify_lock && xSemaphoreTake(s_notify_lock, portMAX_DELAY) == pdTRUE) {
                s_guard_q = (madgwick_quaternion_t){1.0f, 0.0f, 0.0f, 0.0f};
                s_guard_active = false;
                s_config_accepted = false;
                s_sensor_reset_status = SHOT_SENSOR_RESET_IDLE;
                s_sensor_reset_command_accepted = false;
                xSemaphoreGive(s_notify_lock);
            }
            ESP_LOGI(TAG, "Central connected, handle=%d",
                     event->connect.conn_handle);
            /* A moderate interval and longer supervision timeout tolerate
             * brief RF fades without compromising the 50 Hz sensor stream. */
            struct ble_gap_upd_params ci = {
                .itvl_min          = 12,
                .itvl_max          = 24,
                .latency           = 0,
                .supervision_timeout = 600,
            };
            ble_gap_update_params(event->connect.conn_handle, &ci);
            request_reliable_phy(event->connect.conn_handle);
        } else {
            __atomic_store_n(&s_conn_handle, BLE_HS_CONN_HANDLE_NONE,
                             __ATOMIC_RELEASE);
            __atomic_store_n(&s_streaming, false, __ATOMIC_RELEASE);
            __atomic_store_n(&s_shot_state, BLE_SHOT_READY, __ATOMIC_RELEASE);
            if (s_notify_lock && xSemaphoreTake(s_notify_lock, portMAX_DELAY) == pdTRUE) {
                s_guard_q = (madgwick_quaternion_t){1.0f, 0.0f, 0.0f, 0.0f};
                s_guard_active = false;
                s_config_accepted = false;
                s_sensor_reset_status = SHOT_SENSOR_RESET_IDLE;
                s_sensor_reset_command_accepted = false;
                xSemaphoreGive(s_notify_lock);
            }
            start_advertising();
        }
        break;

    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "Central disconnected (reason=%d)",
                 event->disconnect.reason);
        __atomic_store_n(&s_conn_handle, BLE_HS_CONN_HANDLE_NONE,
                         __ATOMIC_RELEASE);
        __atomic_store_n(&s_streaming, false, __ATOMIC_RELEASE);
        __atomic_store_n(&s_shot_state, BLE_SHOT_READY, __ATOMIC_RELEASE);
        if (s_notify_lock && xSemaphoreTake(s_notify_lock, portMAX_DELAY) == pdTRUE) {
            s_guard_q = (madgwick_quaternion_t){1.0f, 0.0f, 0.0f, 0.0f};
            s_guard_active = false;
            s_config_accepted = false;
            s_sensor_reset_status = SHOT_SENSOR_RESET_IDLE;
            s_sensor_reset_command_accepted = false;
            xSemaphoreGive(s_notify_lock);
        }
        start_advertising();
        break;

    case BLE_GAP_EVENT_SUBSCRIBE:
        ESP_LOGI(TAG, "subscribe: conn=%d attr=%d notify=%d",
                 event->subscribe.conn_handle,
                 event->subscribe.attr_handle,
                 event->subscribe.cur_notify);
        break;

    case BLE_GAP_EVENT_MTU:
        ESP_LOGI(TAG, "MTU updated: conn=%d mtu=%d",
                 event->mtu.conn_handle, event->mtu.value);
        break;

    case BLE_GAP_EVENT_PHY_UPDATE_COMPLETE:
        if (event->phy_updated.status == 0) {
            ESP_LOGI(TAG, "PHY updated: tx=%uM rx=%uM",
                     event->phy_updated.tx_phy, event->phy_updated.rx_phy);
        } else {
            ESP_LOGW(TAG, "PHY update failed: rc=%d",
                     event->phy_updated.status);
        }
        break;

    case BLE_GAP_EVENT_REPEAT_PAIRING: {
        struct ble_gap_conn_desc desc;
        int rc = ble_gap_conn_find(event->repeat_pairing.conn_handle, &desc);
        if (rc != 0) {
            ESP_LOGE(TAG, "repeat pairing lookup failed: %d", rc);
            return rc;
        }
        ble_store_util_delete_peer(&desc.peer_id_addr);
        ESP_LOGI(TAG, "Removed stale bond; retrying pairing");
        return BLE_GAP_REPEAT_PAIRING_RETRY;
    }

    case BLE_GAP_EVENT_ADV_COMPLETE:
        start_advertising();
        break;

    default:
        break;
    }
    return 0;
}

/* ---------------------------------------------------------------------- */
/* NimBLE host sync callback. */

static void on_sync(void)
{
    int rc = ble_hs_id_infer_auto(0, &s_own_addr_type);
    if (rc != 0) {
        ESP_LOGE(TAG, "Unable to infer BLE address type: %d", rc);
        esp_restart();
        return;
    }

    rc = ble_svc_gap_device_name_set(s_device_name);
    if (rc != 0) {
        ESP_LOGE(TAG, "ble_svc_gap_device_name_set failed: %d", rc);
        esp_restart();
        return;
    }

    /* Initialize device identity from the ESP32 MAC. */
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_BT);
    snprintf(s_device_id, sizeof(s_device_id), "%02X:%02X:%02X:%02X",
             mac[2], mac[3], mac[4], mac[5]);

    /* Pre-seed last packet so a READ before first stream is valid. */
    madgwick_quaternion_t identity = {1.0f, 0.0f, 0.0f, 0.0f};
    xSemaphoreTake(s_notify_lock, portMAX_DELAY);
    build_packet(&identity, 0, &s_last_packet);
    xSemaphoreGive(s_notify_lock);

    start_advertising();
    ESP_LOGI(TAG, "BLE host synced — service 12345678-...9abc ready");
}

/* ---------------------------------------------------------------------- */
/* NimBLE host task. */

static void nimble_host_task(void *param)
{
    nimble_port_run();               /* blocks until nimble_port_stop() */
    nimble_port_freertos_deinit();
}

/* ---------------------------------------------------------------------- */
/* Public API. */

esp_err_t ble_server_handle_command(uint8_t cmd)
{
    switch (cmd) {

    case 0x01:   /* Recenter yaw — capture current yaw as reference */
        ESP_LOGI(TAG, "CMD 0x01 Recenter yaw");
        {
            madgwick_quaternion_t current_q;
            if (imu_bluetooth_get_current_quaternion(&current_q)) {
                float roll, pitch, yaw;
                madgwick_quat_to_euler(&current_q, &roll, &pitch, &yaw);
                /* Reference = pure yaw rotation of current orientation. */
                madgwick_quaternion_t yaw_reference;
                madgwick_euler_to_quat(0.0f, 0.0f, yaw, &yaw_reference);
                xSemaphoreTake(s_notify_lock, portMAX_DELAY);
                s_guard_q = yaw_reference;
                s_guard_active = true;
                xSemaphoreGive(s_notify_lock);
                ESP_LOGI(TAG, "Yaw recentered at %.2f deg", (double)RAD2DEG(yaw));
            }
        }
        return ESP_OK;

    case 0x02:   /* Full reset — identity quaternion, clear guard, reset filter */
        ESP_LOGI(TAG, "CMD 0x02 Full reset");
        xSemaphoreTake(s_notify_lock, portMAX_DELAY);
        s_guard_q = (madgwick_quaternion_t){1.0f, 0.0f, 0.0f, 0.0f};
        s_guard_active = false;
        xSemaphoreGive(s_notify_lock);
        /* Request filter re-init from the IMU task (thread-safe). */
        imu_bluetooth_request_filter_reset();
        return ESP_OK;

    case 0x03:   /* Take Guard — capture current orientation as reference */
        ESP_LOGI(TAG, "CMD 0x03 Take Guard — q_guard captured");
        /* q_guard = q_current: all future streaming will be reported as
         * q_rel = q_current ⊗ q_guard⁻¹ (see ble_server_notify_quaternion). */
        {
            madgwick_quaternion_t current_q;
            bool captured = false;
            if (imu_bluetooth_get_current_quaternion(&current_q)) {
                xSemaphoreTake(s_notify_lock, portMAX_DELAY);
                s_guard_q = current_q;
                s_guard_active = true;
                captured = true;
                xSemaphoreGive(s_notify_lock);
                ESP_LOGI(TAG, "Guard frame set: w=%.4f x=%.4f y=%.4f z=%.4f",
                         (double)s_guard_q.w, (double)s_guard_q.x,
                         (double)s_guard_q.y, (double)s_guard_q.z);
            }
            if (!captured) {
                ESP_LOGW(TAG, "Take Guard ignored — no valid quaternion yet");
            } else {
                /* Preserve the captured reference; reset only via the IMU owner task. */
                imu_bluetooth_request_sensor_reset();
            }
            return captured ? ESP_OK : ESP_ERR_INVALID_STATE;
        }

    case 0x04:   /* Clear Reference — revert to absolute orientation */
        if (!s_notify_lock || xSemaphoreTake(s_notify_lock, portMAX_DELAY) != pdTRUE) {
            return ESP_ERR_INVALID_STATE;
        }
        const bool rearmed = shot_state_clear_reference(
            &s_shot_state, &s_sensor_reset_status,
            &s_sensor_reset_command_accepted);
        if (rearmed) s_guard_active = false;
        const uint8_t reset_status = s_sensor_reset_status;
        xSemaphoreGive(s_notify_lock);
        if (!rearmed) {
            ESP_LOGW(TAG, "CMD 0x04 rejected — IMU reset still pending");
            return ESP_ERR_INVALID_STATE;
        }
        ESP_LOGI(TAG, "CMD 0x04 Clear reference; shot state re-armed (reset_status=%u)",
                 (unsigned)reset_status);
        return ESP_OK;

    case 0x05:   /* Start stream — enable BLE notifications */
        __atomic_store_n(&s_streaming, true, __ATOMIC_RELEASE);
        ESP_LOGI(TAG, "CMD 0x05 Start stream");
        return ESP_OK;

    case 0x06:   /* Pause stream — keep IMU fusion running */
        __atomic_store_n(&s_streaming, false, __ATOMIC_RELEASE);
        ESP_LOGI(TAG, "CMD 0x06 Pause stream");
        return ESP_OK;

    case 0x08:   /* Browser accepted the LCD start request. */
        if (shot_state_enter(&s_shot_state, BLE_SHOT_IN_PROGRESS,
                             BLE_SHOT_IN_PROGRESS)) {
            if (s_notify_lock && xSemaphoreTake(s_notify_lock, portMAX_DELAY) == pdTRUE) {
                s_sensor_reset_status = SHOT_SENSOR_RESET_IDLE;
                s_sensor_reset_command_accepted = false;
                xSemaphoreGive(s_notify_lock);
            }
            ESP_LOGI(TAG, "CMD 0x08 Shot in progress; reset latch cleared");
        } else {
            ESP_LOGW(TAG, "CMD 0x08 duplicate; shot already in progress");
        }
        return ESP_OK;

    case 0x09:   /* Browser has displayed the result; accept another touch. */
        __atomic_store_n(&s_shot_state, BLE_SHOT_READY, __ATOMIC_RELEASE);
        if (s_notify_lock && xSemaphoreTake(s_notify_lock, portMAX_DELAY) == pdTRUE) {
            s_sensor_reset_status = SHOT_SENSOR_RESET_IDLE;
            s_sensor_reset_command_accepted = false;
            xSemaphoreGive(s_notify_lock);
        }
        ESP_LOGI(TAG, "CMD 0x09 Shot ready");
        return ESP_OK;

    case 0x0A: { /* Reset the sensor before the browser countdown. */
        if (!s_notify_lock || xSemaphoreTake(s_notify_lock, portMAX_DELAY) != pdTRUE) {
            return ESP_ERR_INVALID_STATE;
        }
        const uint32_t shot_state = ble_server_get_shot_state();
        const uint8_t current_reset_status = s_sensor_reset_status;
        const bool reset_was_accepted = s_sensor_reset_command_accepted;
        const bool requested = shot_sensor_reset_request(
            shot_state, BLE_SHOT_IN_PROGRESS,
            &s_sensor_reset_command_accepted, &s_sensor_reset_status);
        xSemaphoreGive(s_notify_lock);
        if (!requested) {
            ESP_LOGW(TAG, "CMD 0x0A rejected — shot_state=%u reset_status=%u reset_accepted=%u",
                     (unsigned)shot_state, (unsigned)current_reset_status,
                     reset_was_accepted ? 1U : 0U);
            return ESP_ERR_INVALID_STATE;
        }
        imu_bluetooth_request_sensor_reset();
        ESP_LOGI(TAG, "CMD 0x0A IMU-only reset requested before countdown");
        return ESP_OK;
    }

    default:
        ESP_LOGW(TAG, "Unknown command 0x%02X", cmd);
        return ESP_ERR_INVALID_ARG;
    }
}

/*
 * Notify all subscribed clients with the current quaternion stream.
 * If "Take Guard" is active, report q_rel = q ⊗ q_guard⁻¹.
 */
void ble_server_notify_quaternion(const madgwick_quaternion_t *q, uint8_t flags)
{
    if (q == NULL) {
        return;
    }

    madgwick_quaternion_t send_q = *q;

    /* Apply guard reference if active: q_rel = q_current ⊗ q_guard⁻¹. */
    madgwick_quaternion_t guard_q;
    bool guard_active;
    xSemaphoreTake(s_notify_lock, portMAX_DELAY);
    guard_q = s_guard_q;
    guard_active = s_guard_active;
    xSemaphoreGive(s_notify_lock);
    if (guard_active) {
        madgwick_quaternion_t guard_conj = madgwick_conj(&guard_q);
        madgwick_mult(&send_q, &guard_conj, &send_q);
    }

    if (ble_server_get_shot_state() == BLE_SHOT_START_REQUESTED) {
        flags |= 0x02;
    }

    ble_notify_packet_t pkt;
    build_packet(&send_q, flags, &pkt);

    xSemaphoreTake(s_notify_lock, portMAX_DELAY);
    memcpy(&s_last_packet, &pkt, sizeof(pkt));
    xSemaphoreGive(s_notify_lock);

    /* Preserve the latest packet for GATT reads, but only notify on demand. */
    if (!ble_server_is_streaming()) {
        return;
    }

    uint16_t conn_handle = ble_server_get_conn_handle();
    if (conn_handle == BLE_HS_CONN_HANDLE_NONE) {
        /* No client — buffer the packet (READ will return it). */
        return;
    }

    struct os_mbuf *om = ble_hs_mbuf_from_flat(pkt.data, sizeof(pkt.data));
    if (om == NULL) {
        ESP_LOGE(TAG, "mbuf alloc failed for quaternion notify");
        return;
    }

    int rc = ble_gatts_notify_custom(conn_handle, s_chr_notify_handle, om);
    if (rc != 0) {
        ESP_LOGW(TAG, "notify failed: %d", rc);
    } else {
        static int s_count = 0;
        if (++s_count % 10 == 0) {
            ESP_LOGD(TAG, "notify OK — w=%.4f x=%.4f y=%.4f z=%.4f flags=0x%02X",
                     (double)send_q.w, (double)send_q.x, (double)send_q.y,
                     (double)send_q.z, flags);
        }
    }
}

void ble_server_init(void)
{
    s_notify_lock = xSemaphoreCreateMutex();
    if (!s_notify_lock) {
        ESP_LOGE(TAG, "Failed to create BLE notification mutex");
        esp_restart();
        return;
    }

    /* Initialize the identity quaternion as the guard frame. */
    s_guard_q = (madgwick_quaternion_t){1.0f, 0.0f, 0.0f, 0.0f};
    s_guard_active = false;
    s_config_accepted = false;
    s_sensor_reset_status = SHOT_SENSOR_RESET_IDLE;
    s_sensor_reset_command_accepted = false;
    s_config_sequence = 0;
    s_difficulty = 0;
    s_bowled_probability = 3;
    s_edge_probability = 10;
    s_capture_window_ms = 525;
    s_sampcnt = 1;
    __atomic_store_n(&s_streaming, false, __ATOMIC_RELEASE);
    __atomic_store_n(&s_shot_state, BLE_SHOT_READY, __ATOMIC_RELEASE);

    ESP_ERROR_CHECK(nimble_port_init());

    int rc = ble_att_set_preferred_mtu(247);  /* 17-byte payload needs ≤ 234 payload */
    if (rc != 0) {
        ESP_LOGE(TAG, "ble_att_set_preferred_mtu failed: %d", rc);
        esp_restart();
        return;
    }

    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.sm_bonding = 0;
    ble_hs_cfg.sm_mitm = 0;
    ble_hs_cfg.sm_sc = 1;
    ble_hs_cfg.sm_io_cap = BLE_HS_IO_NO_INPUT_OUTPUT;

    ble_svc_gap_init();
    ble_svc_gatt_init();

    rc = ble_gatts_count_cfg(s_gatt_svcs);
    if (rc != 0) {
        ESP_LOGE(TAG, "ble_gatts_count_cfg failed: %d", rc);
        esp_restart();
        return;
    }
    rc = ble_gatts_add_svcs(s_gatt_svcs);
    if (rc != 0) {
        ESP_LOGE(TAG, "ble_gatts_add_svcs failed: %d", rc);
        esp_restart();
        return;
    }

    nimble_port_freertos_init(nimble_host_task);
    ESP_LOGI(TAG, "BLE server initialized — 17-byte quaternion stream @ 50 Hz default");
}
