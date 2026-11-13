#!/usr/bin/env python3
"""Sintetiza los sonidos del pinball electromecánico (años 70).

Uso:  python3 tools/gen_sounds.py app/src/main/assets/www/sounds
Genera WAV mono 16 bit a 44,1 kHz. Todo es síntesis propia (sin muestras externas).
"""
import os
import sys
import wave

import numpy as np
from scipy import signal

SR = 44100
rng = np.random.default_rng(1975)


def t_axis(dur):
    return np.arange(int(dur * SR)) / SR


def env(t, tau, attack=0.0008):
    e = np.exp(-t / tau)
    if attack > 0:
        e *= np.clip(t / attack, 0, 1)
    return e


def noise(n):
    return rng.standard_normal(n)


def bp(x, lo, hi, order=2):
    sos = signal.butter(order, [lo, hi], btype="band", fs=SR, output="sos")
    return signal.sosfilt(sos, x)


def lp(x, f, order=2):
    sos = signal.butter(order, f, btype="low", fs=SR, output="sos")
    return signal.sosfilt(sos, x)


def hp(x, f, order=2):
    sos = signal.butter(order, f, btype="high", fs=SR, output="sos")
    return signal.sosfilt(sos, x)


def sweep_sine(t, f0, f1, tau_f):
    """Seno cuya frecuencia cae de f0 a f1 exponencialmente (golpe grave)."""
    f = f1 + (f0 - f1) * np.exp(-t / tau_f)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph)


def place(dst, src, at):
    i = int(at * SR)
    n = min(len(src), len(dst) - i)
    if n > 0:
        dst[i:i + n] += src[:n]
    return dst


def finish(x, peak=0.89, fade=0.01):
    x = np.asarray(x, dtype=np.float64)
    x = x - np.mean(x[: min(len(x), 64)]) * 0  # sin DC deliberado
    m = np.max(np.abs(x)) or 1.0
    x = x / m * peak
    nf = int(fade * SR)
    if nf and len(x) > nf:
        x[-nf:] *= np.linspace(1, 0, nf) ** 2
    return x


def save(path, x):
    data = np.clip(x, -1, 1)
    data = (data * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())


# ---------------------------------------------------------------- componentes
def click(dur=0.012, lo=1500, hi=6000, tau=0.002):
    t = t_axis(dur)
    return bp(noise(len(t)), lo, hi) * env(t, tau, 0.0002)


def thump(dur, f0, f1, tau, tau_f=0.012):
    t = t_axis(dur)
    return sweep_sine(t, f0, f1, tau_f) * env(t, tau, 0.0015)


def ring(dur, freqs, amps, taus):
    t = t_axis(dur)
    out = np.zeros_like(t)
    for f, a, ta in zip(freqs, amps, taus):
        out += a * np.sin(2 * np.pi * f * t + rng.uniform(0, 6.28)) * env(t, ta, 0.0005)
    return out


# ---------------------------------------------------------------- sonidos
def chime(f0, dur=1.9):
    """Barra de campana golpeada por el émbolo de un solenoide (marcador EM)."""
    t = t_axis(dur)
    ratios = [1.0, 2.756, 5.404, 8.933]
    amps = [1.0, 0.42, 0.18, 0.07]
    taus = [0.95, 0.38, 0.16, 0.07]
    x = np.zeros_like(t)
    for r, a, ta in zip(ratios, amps, taus):
        # ligera desafinación entre dos modos casi degenerados = batido metálico
        x += a * np.sin(2 * np.pi * f0 * r * t) * env(t, ta, 0.0004)
        x += a * 0.35 * np.sin(2 * np.pi * f0 * r * 1.0021 * t) * env(t, ta * 0.9, 0.0004)
    strike = click(0.02, 2500, 9000, 0.0015) * 0.55
    plunger = thump(0.05, 260, 120, 0.012) * 0.25
    place(x, strike, 0)
    place(x, plunger, 0)
    return finish(x, fade=0.15)


def flipper_up():
    x = np.zeros(int(0.22 * SR))
    place(x, thump(0.2, 150, 55, 0.028), 0)
    place(x, click(0.03, 1200, 4500, 0.006) * 0.9, 0)
    place(x, ring(0.12, [2150, 3340, 4710], [0.18, 0.12, 0.06], [0.04, 0.025, 0.015]), 0.002)
    # tope del recorrido (end-of-stroke)
    place(x, click(0.02, 800, 3000, 0.004) * 0.45, 0.026)
    # zumbido breve de la bobina de retención
    t = t_axis(0.12)
    hum = signal.sawtooth(2 * np.pi * 120 * t) * 0.05 * env(t, 0.05)
    place(x, lp(hum, 900), 0.03)
    return finish(x)


def flipper_down():
    x = np.zeros(int(0.14 * SR))
    place(x, thump(0.12, 110, 50, 0.02) * 0.6, 0)
    place(x, click(0.02, 900, 3500, 0.004) * 0.7, 0)
    place(x, click(0.015, 2000, 6000, 0.002) * 0.3, 0.018)
    return finish(x, peak=0.6)


def pop_bumper():
    x = np.zeros(int(0.34 * SR))
    place(x, thump(0.3, 170, 48, 0.045, 0.015), 0)
    place(x, click(0.04, 500, 3200, 0.012) * 1.1, 0)
    place(x, ring(0.25, [1720, 2630, 3900], [0.25, 0.14, 0.08], [0.07, 0.045, 0.02]), 0.001)
    place(x, click(0.02, 1500, 6000, 0.003) * 0.5, 0.017)  # anillo que vuelve a subir
    return finish(x)


def slingshot():
    x = np.zeros(int(0.24 * SR))
    place(x, thump(0.2, 140, 60, 0.026), 0)
    place(x, click(0.03, 1000, 5500, 0.007) * 1.0, 0)
    t = t_axis(0.1)
    rubber = np.sin(2 * np.pi * 410 * t) * env(t, 0.018) * 0.35
    place(x, rubber, 0.003)
    place(x, ring(0.12, [2400, 3550], [0.12, 0.08], [0.03, 0.02]), 0)
    return finish(x)


def knocker():
    x = np.zeros(int(0.65 * SR))
    place(x, thump(0.6, 95, 42, 0.11, 0.02), 0)
    t = t_axis(0.3)
    wood = bp(noise(len(t)), 140, 650) * env(t, 0.06) * 0.9
    place(x, wood, 0)
    place(x, click(0.03, 600, 4000, 0.006) * 1.2, 0)
    place(x, ring(0.4, [182, 297, 455], [0.25, 0.15, 0.1], [0.12, 0.09, 0.05]), 0)
    return finish(x, fade=0.05)


def drop_target():
    x = np.zeros(int(0.18 * SR))
    place(x, thump(0.12, 210, 90, 0.016), 0)
    place(x, click(0.03, 900, 3500, 0.008) * 0.9, 0)
    place(x, click(0.02, 400, 1600, 0.006) * 0.5, 0.03)  # cae y toca fondo
    return finish(x, peak=0.8)


def target_reset():
    x = np.zeros(int(0.5 * SR))
    place(x, thump(0.4, 120, 45, 0.07), 0)
    place(x, click(0.04, 500, 2800, 0.012) * 1.1, 0)
    for i, d in enumerate([0.012, 0.024, 0.031, 0.046]):
        place(x, click(0.02, 1200, 5000, 0.003) * (0.6 - i * 0.08), d)
    place(x, ring(0.3, [1310, 2050], [0.12, 0.07], [0.08, 0.04]), 0)
    return finish(x)


def standup():
    x = np.zeros(int(0.15 * SR))
    place(x, thump(0.1, 260, 120, 0.012), 0)
    place(x, click(0.025, 1500, 5000, 0.005) * 0.8, 0)
    place(x, ring(0.08, [3100], [0.1], [0.02]), 0)
    return finish(x, peak=0.75)


def rollover():
    x = np.zeros(int(0.07 * SR))
    place(x, click(0.02, 2000, 7000, 0.0025) * 0.8, 0)
    place(x, thump(0.04, 380, 200, 0.006) * 0.4, 0)
    place(x, click(0.015, 1500, 5000, 0.002) * 0.35, 0.03)
    return finish(x, peak=0.55)


def spinner_tick():
    x = np.zeros(int(0.045 * SR))
    place(x, click(0.015, 3000, 8000, 0.0015) * 0.8, 0)
    place(x, ring(0.04, [2650, 4100], [0.25, 0.1], [0.007, 0.004]), 0)
    return finish(x, peak=0.5)


def reel_click():
    x = np.zeros(int(0.05 * SR))
    place(x, click(0.015, 1500, 5200, 0.0022) * 0.8, 0)
    place(x, ring(0.04, [1180, 1830], [0.25, 0.12], [0.009, 0.005]), 0)
    place(x, thump(0.03, 300, 160, 0.005) * 0.3, 0)
    return finish(x, peak=0.45)


def ball_hit():
    x = np.zeros(int(0.06 * SR))
    place(x, thump(0.05, 320, 180, 0.008), 0)
    place(x, click(0.015, 1800, 6500, 0.0018) * 0.7, 0)
    place(x, ring(0.05, [2900, 4400], [0.12, 0.06], [0.01, 0.006]), 0)
    return finish(x, peak=0.6)


def rubber_hit():
    x = np.zeros(int(0.08 * SR))
    place(x, thump(0.07, 210, 120, 0.014), 0)
    place(x, click(0.015, 600, 2500, 0.003) * 0.4, 0)
    return finish(x, peak=0.55)


def saucer_in():
    x = np.zeros(int(0.3 * SR))
    place(x, thump(0.15, 160, 90, 0.03), 0)
    place(x, click(0.02, 800, 3000, 0.005) * 0.7, 0)
    for i, d in enumerate([0.05, 0.085, 0.11]):
        place(x, thump(0.06, 200, 140, 0.01) * (0.4 - i * 0.1), d)
    return finish(x, peak=0.8)


def saucer_kick():
    x = np.zeros(int(0.3 * SR))
    place(x, thump(0.28, 130, 42, 0.05), 0)
    place(x, click(0.04, 600, 3500, 0.01) * 1.0, 0)
    place(x, ring(0.2, [1450, 2240], [0.16, 0.08], [0.06, 0.03]), 0)
    return finish(x)


def plunger_pull():
    t = t_axis(0.45)
    # muelle que se comprime: ruido muy resonante cuyo centro sube
    x = np.zeros_like(t)
    seg = int(0.03 * SR)
    for k, f in enumerate(np.linspace(700, 1500, 14)):
        n = bp(noise(seg), f * 0.97, f * 1.03, order=2) * np.hanning(seg)
        place(x, n * 0.6, k * 0.028)
    x *= np.clip(t / 0.03, 0, 1)
    place(x, click(0.02, 900, 3000, 0.004) * 0.3, 0)
    return finish(x, peak=0.35, fade=0.05)


def plunger_release():
    x = np.zeros(int(0.6 * SR))
    place(x, thump(0.2, 180, 70, 0.03), 0)
    place(x, click(0.03, 900, 4000, 0.006) * 0.9, 0)
    t = t_axis(0.5)
    vib = 1 + 0.02 * np.sin(2 * np.pi * 23 * t)
    twang = np.sin(2 * np.pi * np.cumsum(310 * vib) / SR) * env(t, 0.09) * 0.45
    twang += np.sin(2 * np.pi * np.cumsum(620 * vib) / SR) * env(t, 0.05) * 0.2
    place(x, twang, 0.004)
    whoosh = bp(noise(int(0.25 * SR)), 300, 1800) * env(t_axis(0.25), 0.08) * 0.25
    place(x, whoosh, 0.01)
    return finish(x, fade=0.06)


def drain():
    x = np.zeros(int(1.0 * SR))
    t = t_axis(0.55)
    roll = lp(noise(len(t)), 380) * (0.6 + 0.4 * np.sin(2 * np.pi * 14 * t))
    roll *= np.clip(t / 0.05, 0, 1) * np.clip((0.55 - t) / 0.1, 0, 1)
    place(x, roll * 0.8, 0)
    place(x, thump(0.3, 110, 45, 0.06), 0.55)
    place(x, click(0.03, 500, 2500, 0.008) * 0.8, 0.55)
    place(x, thump(0.12, 180, 90, 0.02) * 0.5, 0.68)
    return finish(x, peak=0.8, fade=0.08)


def tilt_buzz(dur=1.0):
    t = t_axis(dur)
    sq = signal.square(2 * np.pi * 112 * t, duty=0.4)
    am = 0.75 + 0.25 * signal.square(2 * np.pi * 28 * t)
    x = lp(sq * am, 2200, 2) + 0.15 * bp(noise(len(t)), 1500, 5000) * am
    x *= np.clip(t / 0.01, 0, 1) * np.clip((dur - t) / 0.05, 0, 1)
    place(x, thump(0.1, 120, 60, 0.03) * 1.2, 0)
    return finish(x, peak=0.7)


def tilt_warn():
    x = tilt_buzz(0.18)
    return finish(x, peak=0.55)


def coin():
    x = np.zeros(int(0.75 * SR))
    clink = ring(0.25, [4210, 6080, 7730, 9350], [0.5, 0.35, 0.25, 0.12], [0.06, 0.045, 0.03, 0.02])
    place(x, clink, 0)
    place(x, click(0.01, 4000, 10000, 0.001) * 0.4, 0)
    place(x, clink * 0.45, 0.085)
    place(x, clink * 0.2, 0.135)
    t = t_axis(0.22)
    rollc = bp(noise(len(t)), 2500, 6000) * 0.08 * (0.5 + 0.5 * np.sin(2 * np.pi * 40 * t))
    place(x, rollc, 0.17)
    place(x, thump(0.15, 140, 70, 0.025) * 0.6, 0.42)
    place(x, click(0.02, 800, 3000, 0.005) * 0.6, 0.42)
    return finish(x, peak=0.7, fade=0.05)


def game_start():
    """Reinicio de rodillos: tableteo de relés y rodillos girando a cero."""
    x = np.zeros(int(1.15 * SR))
    place(x, thump(0.2, 130, 50, 0.04), 0)
    place(x, click(0.03, 600, 3000, 0.008), 0)
    tt = 0.09
    for i in range(22):
        place(x, reel_click() * (0.65 + 0.35 * rng.random()), tt)
        tt += 0.034 + 0.006 * rng.random()
    t = t_axis(0.9)
    motor = lp(signal.sawtooth(2 * np.pi * 60 * t), 400) * 0.08 * np.clip(t / 0.1, 0, 1) * np.clip((0.9 - t) / 0.1, 0, 1)
    place(x, motor, 0.08)
    place(x, thump(0.25, 120, 45, 0.05) * 0.9, tt + 0.02)
    place(x, click(0.03, 600, 3000, 0.008) * 0.8, tt + 0.02)
    return finish(x, peak=0.75, fade=0.05)


def roll_loop(dur=2.0):
    """Rodadura de la bola sobre madera: ruido grave, bucle sin cortes."""
    n = int(dur * SR)
    fade = int(0.25 * SR)
    base = noise(n + fade)
    brown = np.cumsum(base)
    brown = hp(brown, 25, 2)
    x = lp(brown, 420, 3) + 0.25 * bp(base, 120, 260)
    # ligera textura (vetas de la madera)
    tt = np.arange(n + fade) / SR
    x *= 0.85 + 0.15 * np.sin(2 * np.pi * 9.5 * tt) * np.sin(2 * np.pi * 3.1 * tt)
    # cruce para que el final empalme con el principio
    head = x[:fade].copy()
    body = x[fade:].copy()
    w = np.linspace(0, 1, fade)
    body[-fade:] = body[-fade:] * (1 - w) + head * w
    x = body / (np.max(np.abs(body)) or 1) * 0.8
    return x


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "sounds"
    os.makedirs(out, exist_ok=True)
    sounds = {
        "chime10": chime(1318.5),   # Mi6 — decenas
        "chime100": chime(1046.5),  # Do6 — centenas
        "chime1000": chime(784.0),  # Sol5 — millares
        "flip_up": flipper_up(),
        "flip_down": flipper_down(),
        "bumper": pop_bumper(),
        "sling": slingshot(),
        "knocker": knocker(),
        "drop": drop_target(),
        "reset": target_reset(),
        "standup": standup(),
        "rollover": rollover(),
        "spinner": spinner_tick(),
        "reel": reel_click(),
        "hit": ball_hit(),
        "rubber": rubber_hit(),
        "saucer_in": saucer_in(),
        "saucer_kick": saucer_kick(),
        "pull": plunger_pull(),
        "launch": plunger_release(),
        "drain": drain(),
        "tilt": tilt_buzz(),
        "warn": tilt_warn(),
        "coin": coin(),
        "start": game_start(),
        "roll": roll_loop(),
    }
    total = 0
    for name, x in sounds.items():
        p = os.path.join(out, name + ".wav")
        save(p, x)
        total += os.path.getsize(p)
        print(f"{name:12s} {len(x)/SR:5.2f}s")
    print(f"total {total/1024:.0f} KiB")


if __name__ == "__main__":
    main()
