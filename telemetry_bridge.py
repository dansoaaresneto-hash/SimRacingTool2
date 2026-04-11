import socketio
import time
import sys
import math
import psutil

sys.path.insert(0, '.')
from pyRfactor2SharedMemory.sharedMemoryAPI import SimInfoAPI, Cbytestring2Python

SERVER_URL = "https://simracingtool2.onrender.com"

sio = socketio.Client()

@sio.event
def connect():
    print("\n[SISTEMA] Conectado ao servidor!")

@sio.event
def disconnect():
    print("\n[SISTEMA] Desconectado do servidor.")

def format_lap_time(seconds_float):
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

def lmu_is_running():
    for proc in psutil.process_iter(['name']):
        try:
            nome = proc.info['name'].lower()
            if 'lemansultimate' in nome or 'lmu' in nome or 'rfactor2' in nome:
                return True, proc.info['name']
        except:
            pass
    return False, None

def main():
    info = SimInfoAPI()
    sio.connect(SERVER_URL)

    print("\n========================================")
    print("  SimRacing Telemetry Bridge - LMU")
    print("========================================")
    print(f"  Servidor: {SERVER_URL}\n")

    status_anterior = None

    while True:
        try:
            rodando, nome_proc = lmu_is_running()
            sm_ok = info.isSharedMemoryAvailable()
            na_pista = info.isOnTrack()

            status_atual = (rodando, sm_ok, na_pista)

            if status_atual != status_anterior:
                print("\n--- DIAGNÓSTICO ---")
                print(f"  LMU rodando   : {'✅ SIM (' + nome_proc + ')' if rodando else '❌ NÃO detectado'}")
                print(f"  Shared Memory : {'✅ OK' if sm_ok else '❌ NÃO disponível'}")
                print(f"  Na pista      : {'✅ SIM' if na_pista else '⏳ NÃO (menu/garagem)'}")
                print("-------------------\n")
                status_anterior = status_atual

                sio.emit('telemetry_status', {
                    "lmu_running": rodando,
                    "shared_memory": sm_ok,
                    "on_track": na_pista,
                    "message": (
                        "LMU não detectado" if not rodando else
                        "Shared Memory não disponível" if not sm_ok else
                        "No menu / garagem" if not na_pista else
                        "Conectado"
                    )
                })

            if sm_ok and na_pista:
                # rF2VehicleTelemetry campos corretos
                v = info.playersVehicleTelemetry()
                # rF2VehicleScoring campos corretos
                s = info.playersVehicleScoring()
                # rF2ScoringInfo campos corretos
                scor = info.Rf2Scor.mScoringInfo

                speed_kmh = math.sqrt(
                    v.mLocalVel.z**2 + v.mLocalVel.x**2 + v.mLocalVel.y**2
                ) * 3.6

                g_lat = v.mLocalAccel.x / 9.80665
                g_lon = v.mLocalAccel.z / 9.80665

                # mLapDist no ScoringInfo = comprimento total da pista
                track_len = scor.mLapDist
                # mLapDist no VehicleScoring = distância percorrida pelo carro
                dist_pct = (s.mLapDist / track_len) * 100 if track_len > 0 else 0

                track_name = Cbytestring2Python(scor.mTrackName) or "Desconhecida"

                # mWheels[i]: FL=0, FR=1, RL=2, RR=3
                # mTemperature[3]: left/center/right do pneu em Kelvin
                # mWear: 0.0-1.0
                tire_wear = [int(v.mWheels[i].mWear * 100) for i in range(4)]
                tire_temp = [int(v.mWheels[i].mTemperature[1] - 273.15) for i in range(4)]

                # Tempo atual na volta = mTimeIntoLap
                # Melhor volta = mBestLapTime
                # Última volta = mLastLapTime
                # Setores da última volta: mLastSector1, mLastSector2 (acumulado)
                last_s1 = float(s.mLastSector1)
                last_s2 = float(s.mLastSector2) - last_s1  # s2 é acumulado, subtrai s1
                last_s3 = float(s.mLastLapTime) - float(s.mLastSector2)

                data = {
                    "speed": int(speed_kmh),
                    "rpm": int(v.mEngineRPM),
                    "gear": int(v.mGear),
                    "fuel": round(float(v.mFuel), 2),
                    "fuelCapacity": round(float(v.mFuelCapacity), 2),
                    "tireWear": tire_wear,
                    "tireTemp": tire_temp,
                    "brake": int(v.mUnfilteredBrake * 100),
                    "throttle": int(v.mUnfilteredThrottle * 100),
                    "steering": round(float(v.mUnfilteredSteering), 3),
                    "gLat": round(g_lat, 2),
                    "gLon": round(g_lon, 2),
                    "lapNumber": int(s.mTotalLaps) + 1,
                    "lapTime": format_lap_time(s.mTimeIntoLap),
                    "bestLapTime": float(s.mBestLapTime),
                    "lastLapTime": format_lap_time(s.mLastLapTime),
                    "sectors": [last_s1, last_s2, last_s3],
                    "curSector1": float(s.mCurSector1),
                    "curSector2": float(s.mCurSector2),
                    "estimatedLapTime": float(s.mEstimatedLapTime),
                    "trackPos": round(dist_pct, 1),
                    "lap_dist_pct": round(dist_pct, 2),
                    "pos_x": float(v.mPos.x),
                    "pos_z": float(v.mPos.z),
                    "trackName": track_name,
                    "weather": "Chuva" if scor.mRaining > 0.1 else "Seco",
                    "trackTemp": round(float(scor.mTrackTemp), 1),
                    "ambientTemp": round(float(scor.mAmbientTemp), 1),
                    "place": int(s.mPlace),
                    "inPits": bool(s.mInPits),
                    "simulated": False
                }

                sio.emit('telemetry', data)

                sys.stdout.write(
                    f"\r[LIVE] {track_name} | "
                    f"P{data['place']} | "
                    f"Lap {data['lapNumber']} | "
                    f"{data['speed']}km/h | "
                    f"Marcha {data['gear']} | "
                    f"RPM {data['rpm']} | "
                    f"Fuel {data['fuel']}L    "
                )
                sys.stdout.flush()

            else:
                msg = (
                    "❌ LMU não detectado. Abra o jogo." if not rodando else
                    "❌ Plugin Shared Memory não instalado." if not sm_ok else
                    "⏳ Aguardando entrar na pista..."
                )
                sio.emit('telemetry', {"simulated": False, "waiting": True, "message": msg})
                time.sleep(1)
                continue

            time.sleep(0.1)

        except KeyboardInterrupt:
            print("\n\n[SISTEMA] Encerrando...")
            break
        except Exception as e:
            print(f"\n[ERRO] {e}")
            time.sleep(1)

    if sio.connected:
        sio.disconnect()

if __name__ == "__main__":
    main()
