# camera → face detection → embedding extraction →
# compare to local database → show Granted/Denied


# install: pip install insightface opencv-python numpy onnxruntime-gpu
import cv2
import numpy as np
import insightface
from insightface.app import FaceAnalysis
import pickle, os
import firebase_admin
from firebase_admin import credentials, firestore
import base64
import time

LOG_COOLDOWN_SECONDS = 120

# ── 1. Initialize model (uses GPU on Jetson via CUDA/ONNX) ──────────────────
app = FaceAnalysis(name='buffalo_l', providers=['CUDAExecutionProvider'])
app.prepare(ctx_id=0, det_size=(640, 640))

EMBEDDINGS_FILE = 'face_db.pkl'
cred = credentials.Certificate("facedetect-7320e-firebase-adminsdk-fbsvc-90c63bb9c0.json")
firebase_admin.initialize_app(cred)

db = firestore.client()


# ── 2. Enrollment ────────────────────────────────────────────────────────────
def enroll_people(image_dir: str):
    """
    image_dir should contain subfolders named after each person:
      images/
        Alice/  photo1.jpg  photo2.jpg
        Bob/    photo1.jpg
        ...
    """
    db = {}
    for person_name in os.listdir(image_dir):
        person_path = os.path.join(image_dir, person_name)
        if not os.path.isdir(person_path):
            continue
        embeddings = []
        for fname in os.listdir(person_path):
            img = cv2.imread(os.path.join(person_path, fname))
            if img is None:
                continue
            faces = app.get(img)
            if faces:
                embeddings.append(faces[0].normed_embedding)
        if embeddings:
            # Average all photos for robustness
            db[person_name] = np.mean(embeddings, axis=0)
            print(f"Enrolled {person_name} ({len(embeddings)} photos)")
    with open(EMBEDDINGS_FILE, 'wb') as f:
        pickle.dump(db, f)
    print("Enrollment saved to", EMBEDDINGS_FILE)


def generate_embeddings():
    users = db.collection("authorizedUsers").stream()

    for user_doc in users:
        user = user_doc.to_dict()

        if user.get("embedding"):
            continue

        image_data_url = user.get("faceCapture", {}).get("imageDataUrl")

        if not image_data_url:
            print(f"Skipping {user.get('fullName')} — no imageDataUrl")
            continue

        try:
            base64_data = image_data_url.split(",")[1]
            image_bytes = base64.b64decode(base64_data)

            np_arr = np.frombuffer(image_bytes, np.uint8)
            img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

            faces = app.get(img)

            if not faces:
                print(f"No face found for {user.get('fullName')}")
                continue

            embedding = faces[0].normed_embedding.tolist()

            user_doc.reference.update({
                "embedding": embedding,
                "embeddingVersion": "insightface-buffalo-l-v1",
                "faceCapture.qualityNote": "Embedding generated"
            })

            print(f"Generated embedding for {user.get('fullName')}")

        except Exception as e:
            print(f"Error generating embedding for {user.get('fullName')}: {e}")


# --Get embeddings from Firestore--
DOOR_ID = "door_486d5bfa-a7c6-4b40-a76a-3c77b49d55e1"


def load_embeddings_for_this_door():
    assignments = db.collection("doorAssignments") \
        .where("doorId", "==", DOOR_ID) \
        .stream()

    allowed_user_ids = [doc.to_dict()["userId"] for doc in assignments]

    names = []
    embeddings = []

    for user_id in allowed_user_ids:
        user_doc = db.collection("authorizedUsers").document(user_id).get()

        if not user_doc.exists:
            continue

        user = user_doc.to_dict()

        if user.get("status") != "authorized":
            continue

        embedding = user.get("embedding")

        if not embedding:
            print(f"Skipping {user.get('fullName')} — no embedding yet")
            continue

        names.append(user["fullName"])

        embeddings.append(
            np.array(embedding, dtype=np.float32)
        )

    if len(embeddings) == 0:
        return [], np.array([])

    return names, np.stack(embeddings)


# ── 3. Recognition ───────────────────────────────────────────────────────────
def recognize(threshold=0.4):
    frame_count = 0
    if frame_count % 3000 == 0:
        names, known_embeddings = load_embeddings_for_this_door()

    if len(names) == 0:
        print("No embeddings found in Firestore.")
        return

    cap = cv2.VideoCapture(0)
    print("Press Q to quit")
    last_log_time = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        frame_count += 1

        faces = app.get(frame)

        for face in faces:
            emb = face.normed_embedding  # already L2-normalized
            # Cosine similarity = dot product of normalized vectors
            sims = known_embeddings @ emb
            best_idx = np.argmax(sims)
            best_score = sims[best_idx]

            label = f"Granted: {names[best_idx]}" if best_score >= threshold else "Denied"
            color = (0, 220, 80) if label != "Denied" else (0, 80, 220)
            current_time = time.time()

            if current_time - last_log_time > LOG_COOLDOWN_SECONDS:
                db.collection("accessLogs").add({
                    "accountId": db.collection("doors").document(DOOR_ID).get().to_dict().get("accountId"),
                    "doorId": DOOR_ID,
                    "userName": names[best_idx] if best_score >= threshold else "Unknown",
                    "result": "granted" if best_score >= threshold else "denied",
                    "score": float(best_score),
                    "timestamp": firestore.SERVER_TIMESTAMP
                })

            last_log_time = current_time
            # Draw box and name
            box = face.bbox.astype(int)
            cv2.rectangle(frame, (box[0], box[1]), (box[2], box[3]), color, 2)
            cv2.putText(frame, f"{label}  {best_score:.2f}",
                        (box[0], box[1] - 10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2)

        cv2.imshow('Face Recognition', frame)
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    cap.release()
    cv2.destroyAllWindows()


# ── 4. Run ───────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    generate_embeddings()
    recognize(threshold=0.4)