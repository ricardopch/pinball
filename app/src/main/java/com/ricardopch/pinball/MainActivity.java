package com.ricardopch.pinball;

import android.app.Activity;
import android.content.SharedPreferences;
import android.content.res.AssetFileDescriptor;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.SoundPool;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.view.DisplayCutout;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.util.HashMap;

/**
 * Envoltorio nativo del pinball: pantalla completa, sensores de inclinación,
 * teclas de volumen para el lanzador, sonido de baja latencia (SoundPool) y vibración.
 * El juego en sí está en assets/www (HTML5 canvas).
 */
public class MainActivity extends Activity implements SensorEventListener {

    private WebView web;
    private SensorManager sensorManager;
    private Sensor gravitySensor, accelSensor;
    private boolean hasGravity;

    private final Object lock = new Object();
    private final float[] grav = {0f, 6.3f, 7.6f};
    private boolean gravInit = false;
    private float peakX, peakY, peakMag;

    private SoundPool pool;
    private final HashMap<String, Integer> sounds = new HashMap<>();
    private int rollSoundId = 0;
    private volatile int rollStream = 0;
    private volatile float rollVol = 0f, rollRate = 1f;

    private Vibrator vibrator;
    private AudioManager audio;
    private SharedPreferences prefs;

    private volatile String jsState = "boot";
    private volatile boolean jsReady = false;
    private volatile float safeTopDp = 0f, safeBottomDp = 0f;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = w.getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            w.setAttributes(lp);
        }
        setVolumeControlStream(AudioManager.STREAM_MUSIC);

        prefs = getSharedPreferences("pinball", MODE_PRIVATE);
        audio = (AudioManager) getSystemService(AUDIO_SERVICE);
        initVibrator();
        initSound();
        sensorManager = (SensorManager) getSystemService(SENSOR_SERVICE);
        if (sensorManager != null) {
            gravitySensor = sensorManager.getDefaultSensor(Sensor.TYPE_GRAVITY);
            accelSensor = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        }
        hasGravity = gravitySensor != null;

        web = new WebView(this);
        web.setBackgroundColor(0xFF120A05);
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setTextZoom(100);
        ws.setSupportZoom(false);
        ws.setBuiltInZoomControls(false);
        ws.setDisplayZoomControls(false);
        ws.setAllowContentAccess(false);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setHapticFeedbackEnabled(false);
        web.setLongClickable(false);
        web.setOnLongClickListener(v -> true);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true; // el juego no navega fuera
            }
        });
        web.addJavascriptInterface(new Bridge(), "AndroidPB");
        web.setOnApplyWindowInsetsListener((v, insets) -> {
            readInsets(insets);
            return insets;
        });
        setContentView(web);
        hideSystemUi();
        web.loadUrl("file:///android_asset/www/index.html");
    }

    private void readInsets(WindowInsets insets) {
        float d = getResources().getDisplayMetrics().density;
        int top = 0, bottom = 0;
        if (Build.VERSION.SDK_INT >= 28) {
            DisplayCutout dc = insets.getDisplayCutout();
            if (dc != null) {
                top = dc.getSafeInsetTop();
                bottom = dc.getSafeInsetBottom();
            }
        }
        safeTopDp = top / d;
        safeBottomDp = bottom / d;
    }

    @SuppressWarnings("deprecation")
    private void hideSystemUi() {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            w.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    // ------------------------------------------------------------------ sonido

    private void initSound() {
        AudioAttributes aa = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_GAME)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        pool = new SoundPool.Builder().setMaxStreams(24).setAudioAttributes(aa).build();
        pool.setOnLoadCompleteListener((sp, sampleId, status) -> {
            if (status == 0 && sampleId == rollSoundId) {
                rollStream = sp.play(rollSoundId, 0f, 0f, 0, -1, 1f);
                applyRoll();
            }
        });
        try {
            String[] files = getAssets().list("www/sounds");
            if (files != null) {
                for (String f : files) {
                    if (!f.endsWith(".wav")) continue;
                    AssetFileDescriptor afd = getAssets().openFd("www/sounds/" + f);
                    int id = pool.load(afd, 1);
                    String name = f.substring(0, f.length() - 4);
                    sounds.put(name, id);
                    if (name.equals("roll")) rollSoundId = id;
                }
            }
        } catch (IOException ignored) {
        }
    }

    private void applyRoll() {
        int s = rollStream;
        if (s != 0 && pool != null) {
            pool.setVolume(s, rollVol, rollVol);
            pool.setRate(s, rollRate);
        }
    }

    // ------------------------------------------------------------------ vibración

    @SuppressWarnings("deprecation")
    private void initVibrator() {
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                VibratorManager vm = (VibratorManager) getSystemService(VIBRATOR_MANAGER_SERVICE);
                if (vm != null) vibrator = vm.getDefaultVibrator();
            } else {
                vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            }
        } catch (Exception e) {
            vibrator = null;
        }
    }

    // ------------------------------------------------------------------ sensores

    private void registerSensors() {
        if (sensorManager == null) return;
        if (gravitySensor != null)
            sensorManager.registerListener(this, gravitySensor, SensorManager.SENSOR_DELAY_GAME);
        if (accelSensor != null)
            sensorManager.registerListener(this, accelSensor, SensorManager.SENSOR_DELAY_GAME);
    }

    @Override
    public void onSensorChanged(SensorEvent e) {
        int type = e.sensor.getType();
        synchronized (lock) {
            if (type == Sensor.TYPE_GRAVITY) {
                grav[0] = e.values[0];
                grav[1] = e.values[1];
                grav[2] = e.values[2];
                gravInit = true;
            } else if (type == Sensor.TYPE_ACCELEROMETER) {
                float ax = e.values[0], ay = e.values[1], az = e.values[2];
                if (!hasGravity) {
                    // sin sensor de gravedad: filtro paso bajo del acelerómetro
                    float a = gravInit ? 0.12f : 1f;
                    grav[0] += (ax - grav[0]) * a;
                    grav[1] += (ay - grav[1]) * a;
                    grav[2] += (az - grav[2]) * a;
                    gravInit = true;
                }
                if (gravInit) {
                    float lx = ax - grav[0], ly = ay - grav[1];
                    float m = (float) Math.sqrt(lx * lx + ly * ly);
                    if (m > peakMag) {
                        peakMag = m;
                        peakX = lx;
                        peakY = ly;
                    }
                }
            }
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
    }

    // ------------------------------------------------------------------ teclas

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int k = e.getKeyCode();
        if (k == KeyEvent.KEYCODE_VOLUME_UP || k == KeyEvent.KEYCODE_VOLUME_DOWN) {
            // con el menú abierto (o antes de cargar) las teclas vuelven a ser de volumen
            if (!jsReady || "menu".equals(jsState)) return super.dispatchKeyEvent(e);
            if (e.getAction() == KeyEvent.ACTION_DOWN) {
                if (e.getRepeatCount() == 0) js("PB.plunger(true)");
            } else if (e.getAction() == KeyEvent.ACTION_UP) {
                js("PB.plunger(false)");
            }
            return true;
        }
        if (k == KeyEvent.KEYCODE_BACK) {
            if (e.getAction() == KeyEvent.ACTION_UP) {
                if (jsReady) js("PB.onBack()");
                else finish();
            }
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    private void js(String code) {
        if (web == null) return;
        final String c = "try{" + code + "}catch(e){}";
        runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript(c, null);
        });
    }

    // ------------------------------------------------------------------ ciclo de vida

    @Override
    protected void onResume() {
        super.onResume();
        registerSensors();
        if (pool != null) pool.autoResume();
        if (web != null) {
            web.onResume();
            js("PB.onAppResume&&PB.onAppResume()");
        }
        hideSystemUi();
    }

    @Override
    protected void onPause() {
        if (sensorManager != null) sensorManager.unregisterListener(this);
        js("PB.onAppPause&&PB.onAppPause()");
        if (pool != null) pool.autoPause();
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (pool != null) {
            pool.release();
            pool = null;
        }
        if (web != null) {
            web.removeJavascriptInterface("AndroidPB");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    // ------------------------------------------------------------------ puente JS

    private static float clamp(float v, float a, float b) {
        return v < a ? a : (v > b ? b : v);
    }

    private class Bridge {
        @JavascriptInterface
        public String sensors() {
            synchronized (lock) {
                String s = grav[0] + "," + grav[1] + "," + grav[2] + "," + peakX + "," + peakY + "," + peakMag;
                peakX = 0f;
                peakY = 0f;
                peakMag = 0f;
                return gravInit ? s : "0,0,0,0,0,0";
            }
        }

        @JavascriptInterface
        public void play(String name, float vol, float pan, float rate) {
            SoundPool p = pool;
            Integer id = sounds.get(name);
            if (p == null || id == null) return;
            float v = clamp(vol, 0f, 1f);
            float pn = clamp(pan, -1f, 1f);
            float l = v * Math.min(1f, 1f - pn), r = v * Math.min(1f, 1f + pn);
            p.play(id, l, r, 1, 0, clamp(rate, 0.5f, 2f));
        }

        @JavascriptInterface
        public void roll(float vol, float rate) {
            rollVol = clamp(vol, 0f, 1f);
            rollRate = clamp(rate, 0.5f, 2f);
            applyRoll();
        }

        @JavascriptInterface
        public void vibrate(int ms, int amp) {
            Vibrator v = vibrator;
            if (v == null || !v.hasVibrator() || ms <= 0) return;
            try {
                int a = amp <= 0 ? VibrationEffect.DEFAULT_AMPLITUDE : Math.min(255, amp);
                v.vibrate(VibrationEffect.createOneShot(Math.min(ms, 1000), a));
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public float getVolume() {
            int max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            return max > 0 ? audio.getStreamVolume(AudioManager.STREAM_MUSIC) / (float) max : 0f;
        }

        @JavascriptInterface
        public void setVolume(float f) {
            try {
                int max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                audio.setStreamVolume(AudioManager.STREAM_MUSIC, Math.round(clamp(f, 0f, 1f) * max), 0);
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public String load(String key) {
            return prefs.getString(key, "");
        }

        @JavascriptInterface
        public void save(String key, String value) {
            prefs.edit().putString(key, value).apply();
        }

        @JavascriptInterface
        public void setState(String s) {
            jsState = s == null ? "" : s;
            jsReady = true;
        }

        @JavascriptInterface
        public float safeTop() {
            return safeTopDp;
        }

        @JavascriptInterface
        public float safeBottom() {
            return safeBottomDp;
        }

        @JavascriptInterface
        public void exit() {
            runOnUiThread(MainActivity.this::finish);
        }
    }
}
