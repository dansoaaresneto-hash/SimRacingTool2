import socketio
import time
import random
import sys

# NOTA: Para funcionar no seu PC, você deve instalar:
# pip install "python-socketio[client]"
# Se estiver usando rFactor 2 real, instale também:
# pip install pyRfactor2SharedMemory

# URL do seu app no Cloud Run (substitua se necessário)
SERVER_URL = "http://localhost:3000" 

sio = socketio.Client()

@sio.event
def connect():
    print("Conectado ao servidor RaceMind AI!")

@sio.event
def disconnect():
    print("Desconectado do servidor.")

def get_telemetry():
    """
    Simula ou lê a telemetria do rFactor 2.
    Para usar dados REAIS, descomente a parte do pyRfactor2SharedMemory.
    """
    # Exemplo de dados simulados para teste
    return {
        "fuel": 45.5,
        "fuelCapacity": 100,
        "tireWear": [5, 6, 8, 7], # FL, FR, RL, RR
        "weather": "Ensolarado",
        "position": 4,
        "gapAhead": 1.245,
        "gapBehind": 0.890,
        "lapTime": "1:45.230",
        "lastLapTime": "1:44.890",
        "rpm": 7500,
        "speed": 240,
        "gear": 5
    }

def main():
    try:
        sio.connect(SERVER_URL)
        print(f"Enviando telemetria para {SERVER_URL}...")
        
        while True:
            if sio.connected:
                data = get_telemetry()
                sio.emit('telemetry', data)
                # print(f"Dados enviados: Combustível {data['fuel']}L")
            time.sleep(1) # Envia a cada 1 segundo
            
    except Exception as e:
        print(f"Erro: {e}")
    finally:
        sio.disconnect()

if __name__ == "__main__":
    main()
