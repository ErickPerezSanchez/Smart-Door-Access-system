#camera → face detection → embedding extraction →
#compare to local database → show Granted/Denied


# install: pip install insightface opencv-python numpy onnxruntime-gpu
import cv2
import numpy as np
import insightface
from insightface.app import FaceAnalysis
import pickle, os



# ── 1. Initialize model (uses GPU on Jetson via CUDA/ONNX) ──────────────────
app = FaceAnalysis(name='buffalo_l', providers=['CUDAExecutionProvider'])
app.prepare(ctx_id=0, det_size=(640, 640))

EMBEDDINGS_FILE = 'face_db.pkl'

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

# ── 3. Recognition ───────────────────────────────────────────────────────────
def recognize(threshold=0.4):
    with open(EMBEDDINGS_FILE, 'rb') as f:
        db = pickle.load(f)

    if not db:
        print("Face database is empty. Check your image folder path and make sure faces are detected.")
        return

    names = list(db.keys())
    known_embeddings = np.stack(list(db.values()))

    cap = cv2.VideoCapture(0)
    print("Press Q to quit")

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        faces = app.get(frame)

        for face in faces:
            emb = face.normed_embedding  # already L2-normalized
            # Cosine similarity = dot product of normalized vectors
            sims = known_embeddings @ emb
            best_idx = np.argmax(sims)
            best_score = sims[best_idx]

            label = names[best_idx] if best_score >= threshold else "Unknown"
            color = (0, 220, 80) if label != "Unknown" else (0, 80, 220)

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
    if not os.path.exists(EMBEDDINGS_FILE):
        enroll_people('image_dir/images')   # run once to enroll
    recognize(threshold=0.4)      # then run live recognition