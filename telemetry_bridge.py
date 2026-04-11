import socketio
import time
import sys
import math
import random

# Tenta importar a biblioteca de telemetria real
try:
    sys.path.insert(0, '.')
    from pyRfactor2SharedMemory.sharedMemoryAPI import SimInfoAPI, Cbytestring2Python
    REAL_TELEMETRY_AVAILABLE = True
except ImportError as e:
    print(f"[AVISO] Telemetria real não disponível: {e}")
    REAL_TELEMETRY_AVAILABLE = False

# URL do servidor
SERVER_URL = "https://simracingtool2.onrender.com"

sio = socketio.Client()

@sio.event
def connect():
    print("\n[SISTEMA] Conectado ao servidor RaceMind AI!")

@sio.event
def disconnect():
    print("\n[SISTEMA] Desconectado do servidor.")

def format_lap_time(seconds_float):
    """Converte segundos float para formato M:SS.mmm"""
    if seconds_float <= 0:
        return "--:--.---"
    minutes = int(seconds_float // 60)
    seconds = int(seconds_float % 60)
    milliseconds = int(round((seconds_float % 1) * 1000))
    if milliseconds == 1000:
        milliseconds = 0
        seconds += 1
        if seconds == 60:
            seconds = 0
            minutes += 1
    return f"{minutes}:{seconds:02d}.{milliseconds:03d}"

class TelemetryBridge:
    def __init__(self):
        self.reader = None
        self.sim_start_time = time.time()
        self.sim_lap_start = time.time()
        self.sim_lap_count = 1
        self.sim_dist = 0.0

        if REAL_TELEMETRY_AVAILABLE:
            try:
                self.reader = SimInfoAPI()
                print("[SISTEMA] Leitor rFactor2/LMU inicializado.")
                print(f"[SISTEMA] Shared Memory disponível: {self.reader.isSharedMemoryAvailable()}")
            except Exception as e:
                print(f"[ERRO] Falha ao inicializar leitor: {e}")
                self.reader = None

    def get_data(self):
        """Lê dados reais do LMU/rF2 ou retorna simulados."""
        if self.reader:
            try:
                # Verifica se a shared memory está disponível
                if not self.reader.isSharedMemoryAvailable():
                    print("\r[AVISO] Shared Memory não disponível. O plugin está instalado no LMU?", end="")
                else:
                    v = self.reader.playersVehicleTelemetry()
                    s = self.reader.playersVehicleScoring()
                    scor_info = self.reader.Rf2Scor.mScoringInfo

                    # Velocidade em km/h
                    speed_kmh = math.sqrt(
                        v.mLocalVel.z**2 + v.mLocalVel.x**2 + v.mLocalVel.y**2
                    ) * 3.6

                    # Forças G
                    g_lat = v.mLocalAccel.x / 9.80665
                    g_lon = v.mLocalAccel.z / 9.80665

                    # Distância percorrida %
                    track_len = scor_info.mTrackLen
                    dist_pct = (s.mLapDist / track_len) * 100 if track_len > 0 else 0

                    # Nome da pista
                    track_name = Cbytestring2Python(scor_info.mTrackName) or "LMU"

                    return {
                        "speed": int(speed_kmh),
                        "rpm": int(v.mEngineRPM),
                        "gear": int(v.mGear),
                        "fuel": float(v.mFuel),
                        "fuelCapacity": 100.0,
                        "tireWear": [int(v.mWheel[i].mWear * 100) for i in range(4)],
                        "tireTemp": [int(v.mWheel[i].mTemperature[0] - 273.15) for i in range(4)],
                        "brake": int(v.mUnfilteredBrake * 100),
                        "throttle": int(v.mUnfilteredThrottle * 100),
                        "steering": float(v.mUnfilteredSteering),
                        "gLat": round(g_lat, 2),
                        "gLon": round(g_lon, 2),
                        "lapNumber": int(s.mLapNumber),
                        "lapTime": format_lap_time(s.mCurrentLapTime),
                        "bestLapTime": float(s.mBestLapTime),
                        "sectors": [
                            float(s.mLastSector1),
                            float(s.mLastSector2),
                            float(s.mCurEstimatedLapTime - s.mLastSector1 - s.mLastSector2)
                        ],
                        "trackPos": round(dist_pct, 1),
                        "lap_dist_pct": round(dist_pct, 2),
                        "pos_x": float(v.mPos[0]),
                        "pos_z": float(v.mPos[2]),
                        "trackName": track_name,
                        "weather": "Chuva" if scor_info.mRaining > 0.1 else "Seco",
                        "lastLapTime": format_lap_time(s.mLastLapTime)
                    }
            except Exception as e:
                print(f"\n[ERRO leitura] {e}")

        # --- MODO SIMULADO ---
        now = time.time()
        lap_elapsed = now - self.sim_lap_start
        lap_duration = 90.0
        if lap_elapsed >= lap_duration:
            self.sim_lap_start = now
            self.sim_lap_count += 1
            lap_elapsed = 0

        self.sim_dist = (lap_elapsed / lap_duration) * 100
        angle = (lap_elapsed / lap_duration) * 2 * math.pi
        sim_pos_x = 500 * math.cos(angle)
        sim_pos_z = 300 * math.sin(angle)
        phase = (lap_elapsed % 10) / 10
        sim_rpm = 4000 + (math.sin(phase * math.pi) * 4000) + random.randint(-100, 100)
        sim_gear = int(phase * 6) + 2
        sim_speed = 100 + (phase * 150) + random.randint(-5, 5)
        sim_g_lat = math.sin(lap_elapsed * 0.5) * 2.5
        sim_g_lon = math.cos(lap_elapsed * 0.8) * 1.5
        sim_throttle = 80 + math.sin(phase * math.pi) * 20 if phase < 0.8 else 0
        sim_brake = 100 if phase > 0.85 else 0

        return {
            "speed": int(sim_speed),
            "rpm": int(sim_rpm),
            "gear": sim_gear,
            "fuel": max(0, 50.0 - (now - self.sim_start_time) * 0.05),
            "fuelCapacity": 100.0,
            "tireWear": [10, 11, 15, 14],
            "tireTemp": [90 + random.randint(-2, 2) for _ in range(4)],
            "brake": int(sim_brake),
            "throttle": int(sim_throttle),
            "steering": round(math.sin(lap_elapsed) * 0.5, 2),
            "gLat": round(sim_g_lat, 2),
            "gLon": round(sim_g_lon, 2),
            "lapNumber": self.sim_lap_count,
            "lapTime": format_lap_time(lap_elapsed),
            "bestLapTime": 89.450,
            "sectors": [28.5, 32.1, 28.85],
            "trackPos": round(self.sim_dist, 1),
            "lap_dist_pct": round(self.sim_dist, 2),
            "pos_x": round(sim_pos_x, 2),
            "pos_z": round(sim_pos_z, 2),
            "trackName": "Simulado",
            "weather": "Simulado",
            "lastLapTime": "1:29.450"
        }

def main():
    bridge = TelemetryBridge()

    try:
        sio.connect(SERVER_URL)
        print(f"[SISTEMA] Monitorando telemetria...")

        while True:
            if sio.connected:
                data = bridge.get_data()
                sio.emit('telemetry', data)

                status = (
                    f"\r[LIVE] Lap: {data['lapNumber']} | "
                    f"Pista: {data['trackName']} | "
                    f"Pos: {data['trackPos']}% | "
                    f"Spd: {data['speed']}km/h | "
                    f"RPM: {data['rpm']} | "
                    f"Marcha: {data['gear']}    "
                )
                sys.stdout.write(status)
                sys.stdout.flush()

            time.sleep(0.1)

    except KeyboardInterrupt:
        print("\n\n[SISTEMA] Encerrando...")
    except Exception as e:
        print(f"\n[ERRO] {e}")
    finally:
        if sio.connected:
            sio.disconnect()

if __name__ == "__main__":
    main()
