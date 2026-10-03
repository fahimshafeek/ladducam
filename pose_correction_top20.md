# Pose-Correction Rules: Top 20 (MediaPipe Geometry → Issue → Fix)

Shortened from the 105-rule set. These 20 are the most **distinct** (each fires on its own body signal) and the most **sensitive** (a small movement flips them on or off). Original rule IDs are kept so they map back to the full dataset.

## Conventions

- Coordinates: MediaPipe normalized, y increases downward. Convert x·W, y·H to pixels before any distance or angle. Left/right = the subject's own sides. Un-mirror front-camera previews.
- `SW` = dist(LEFT_SHOULDER, RIGHT_SHOULDER). `HW` = dist(LEFT_HIP, RIGHT_HIP). `TL` = dist(mid_shoulder, mid_hip). `EM` = dist(mid_eyes, mid_mouth), the face-size unit.
- `line_angle(A,B)` = angle of line A→B vs horizontal, in (−90°, 90°]. `ang(A,B,C)` = interior angle at B.
- `view`: frontal if SW/TL ≥ 0.65, three_quarter if 0.30–0.65, profile if < 0.30.
- Calibration facts (MediaPipe): SW/HW is about 1.8–2.2 (hip landmarks are joint centers). SW/TL is about 0.8 when frontal. Upright nose-minus-ear vertical offset is about 0.4·EM.
- Thresholds are deliberately tight. Loosen them if the app nags too much. Add hysteresis (clear at 70% of trigger) to stop flicker.

## Rule schema

`ID · CATEGORY · issue_id` → `IF` (condition) · `MOVE` (small movement that triggers it) · `ISSUE` · `FIX` (VLM output text).

---

### R001 · HEAD_NECK · head_down_chin_tucked
- **IF:** (NOSE.y − mean(LEFT_EAR.y, RIGHT_EAR.y)) / EM > 0.75
- **MOVE:** lower the chin about 10–15°
- **ISSUE:** Chin tucked; neck compressed, unflattering shadows.
- **FIX:** "The chin is tucked inward, which compresses the neck and creates shadows. Push the chin slightly forward and lift it toward the light to define the jawline."

### R006 · HEAD_NECK · chin_raised_too_high
- **IF:** (NOSE.y − mean(EAR.y)) / EM < 0.10
- **MOVE:** lift the chin about 10°
- **ISSUE:** Nostrils and underside of the jaw exposed.
- **FIX:** "The chin is raised too far, exposing the jaw underside and nostrils. Lower it a few degrees so the forehead and eyes lead."

### R007 · HEAD_NECK · head_roll_excessive
- **IF:** |line_angle(LEFT_EAR, RIGHT_EAR)| > 8°
- **MOVE:** tilt the head sideways
- **ISSUE:** Unintentional head tilt; off-balance frame.
- **FIX:** "The head is canted. Level it, or tilt deliberately 5–8° toward the lower shoulder for a relaxed look."

### R011 · HEAD_NECK · shoulder_shrug_neck_compressed
- **IF:** mean(SHOULDER.y − EAR.y) / SW < 0.25
- **MOVE:** raise the shoulders toward the ears
- **ISSUE:** Neck disappears; tense posture.
- **FIX:** "The shoulders are hiked up. Inhale, then drop the shoulders down and away from the ears as you exhale."

### R002 · SHOULDERS · uneven_shoulders
- **IF:** |LEFT_SHOULDER.y − RIGHT_SHOULDER.y| / SW > 0.06
- **MOVE:** drop or lift one shoulder
- **ISSUE:** Unbalanced, tense posture.
- **FIX:** "The shoulders are unbalanced. Relax and drop the higher shoulder, or shift weight to the back foot to even the stance."

### R021 · TORSO · torso_lean_sideways
- **IF:** angle(mid_hip→mid_shoulder vs vertical) > 5° AND R082 not firing
- **MOVE:** lean the upper body to one side
- **ISSUE:** One side of the waist is shortened.
- **FIX:** "The torso leans sideways. Center the ribcage over the hips, or lean on a prop so the line looks deliberate."

### R023 · TORSO · hips_tilted_uneven
- **IF:** |LEFT_HIP.y − RIGHT_HIP.y| / SW > 0.06 AND |line_angle(shoulders)| < 3°
- **MOVE:** shift weight onto one leg
- **ISSUE:** Crooked hips with level shoulders look accidental.
- **FIX:** "The hips tilt while the shoulders stay level. Share the weight evenly, or tilt the shoulders slightly the opposite way for a deliberate S-curve."

### R027 · TORSO · torso_twisted_vs_hips
- **IF:** |shoulder_yaw − hip_yaw| > 15°, where yaw(L,R) = atan2((R.z − L.z)·sign(L.x − R.x), |L.x − R.x|)
- **MOVE:** rotate the shoulders without the hips
- **ISSUE:** Waist creasing and twisted look.
- **FIX:** "The shoulders twist away from the hips. Reduce the twist to about 15° or rotate hips and shoulders together."

### R031 · ARMS · arms_crossed_closed
- **IF:** each WRIST is past mid_shoulder.x toward the opposite side by > 0.10·SW AND both WRIST.y between shoulder and hip height
- **MOVE:** fold the arms
- **ISSUE:** Defensive, closed body language.
- **FIX:** "Crossed arms look defensive. Rest one hand lightly on the opposite elbow and relax the other arm, or put a hand in a pocket with the thumb out."

### R033 · ARMS · hand_blocking_face
- **IF:** any WRIST or INDEX lies inside the face box expanded 10% (face box: 2.3·EM wide × 3.5·EM tall, centered on mid_eyes)
- **MOVE:** raise a hand toward the face
- **ISSUE:** Hand covers facial features.
- **FIX:** "A hand covers part of the face. Lower it to the jawline or neck and touch with the fingertips only."

### R034 · ARMS · hands_clasped_fig_leaf
- **IF:** dist(LEFT_WRIST, RIGHT_WRIST) < 0.20·SW AND mid_wrist within 0.25·TL of hip height AND |mid_wrist.x − mid_hip.x| < 0.25·SW
- **MOVE:** bring both hands together in front
- **ISSUE:** Stiff, formal, blocks the torso center.
- **FIX:** "Both hands are clasped in front, which looks stiff. Separate them: one in a pocket or holding an accessory, the other relaxed."

### R043 · ARMS · both_hands_on_hips_symmetric
- **IF:** both dist(WRIST, same-side HIP) < 0.25·SW AND both ang(SHOULDER, ELBOW, WRIST) < 150°
- **MOVE:** put both hands on the hips
- **ISSUE:** Symmetric akimbo looks rigid and aggressive.
- **FIX:** "Both hands on the hips make a rigid shape. Use one hand on the hip and let the other arm hang or hold something."

### R045 · LEGS · locked_knees
- **IF:** both ang(HIP, KNEE, ANKLE) > 172°
- **MOVE:** straighten both legs fully
- **ISSUE:** Rigid, locked legs.
- **FIX:** "The knees are locked straight. Soften one knee with a slight bend and shift weight onto the other leg."

### R046 · LEGS · stance_too_wide
- **IF:** dist(LEFT_ANKLE, RIGHT_ANKLE) > 2.4·HW AND view == frontal
- **MOVE:** step the feet apart
- **ISSUE:** Wide stance broadens the hips.
- **FIX:** "The feet are planted too wide. Narrow to hip width and put one foot slightly in front of the other."

### R047 · LEGS · feet_together_stiff
- **IF:** dist(LEFT_ANKLE, RIGHT_ANKLE) < 0.8·HW AND view == frontal
- **MOVE:** bring the feet together
- **ISSUE:** Attention stance looks stiff.
- **FIX:** "The feet are pressed together. Step one foot forward, angle it about 45°, and put weight on the back foot."

### R004 · ORIENTATION · body_square_to_camera
- **IF:** SW/TL ≥ 0.74 (body within about 20° of facing the lens)
- **MOVE:** face the camera squarely
- **ISSUE:** Overly broad, static look.
- **FIX:** "The subject is square to the lens, which looks broad and static. Pivot the body 45° away from the camera and turn the face back toward the lens."

### R061 · ORIENTATION · over_rotated_body
- **IF:** SW/TL < 0.35 AND vis(LEFT_EAR) > 0.6 AND vis(RIGHT_EAR) > 0.6
- **MOVE:** turn the body nearly sideways while the face stays frontal
- **ISSUE:** Chest line lost; twisted look.
- **FIX:** "The body is turned too far from the camera. Rotate back to about 30–45° so the chest and shoulders still show."

### R005 · FRAMING · no_lead_space
- **IF:** (NOSE.x < 0.15 OR NOSE.x > 0.85) AND the face points toward the nearer edge (|NOSE.x − mid_ear.x| > 0.15·SW, sign toward that edge)
- **MOVE:** walk toward an edge while looking outward
- **ISSUE:** No negative space in the gaze direction; tension.
- **FIX:** "The subject looks out of the frame without space ahead of the gaze. Reframe so the subject sits on the opposite rule-of-thirds line."

### R069 · FRAMING · headroom_too_little
- **IF:** head_top < 0.04, where head_top = (mid_eyes.y − 1.75·EM) / H
- **MOVE:** step closer or tilt the camera down
- **ISSUE:** Head touches the top edge.
- **FIX:** "There is almost no headroom. Tilt the camera up or step back to leave 5–10% space above the head."

### R082 · FRAMING · camera_roll
- **IF:** line_angle of shoulders, hips (and ankles if visible) all have |angle| ≥ 3° with the same sign
- **MOVE:** tilt the phone
- **ISSUE:** Slanted horizon.
- **FIX:** "The whole scene is tilted. Level the horizon with the on-screen grid before shooting."

---

## Quick reference: pairs that flip with small movements

| Movement | Rules that toggle |
|---|---|
| Head pitch up / down | R006 ↔ R001 |
| Head tilt | R007 |
| Shoulders up / uneven | R011, R002 |
| Weight shift / body lean | R023, R021, R027 |
| Hand placement | R031, R033, R034, R043 |
| Foot spacing / knee lock | R047 ↔ R046, R045 |
| Body rotation | R004 ↔ R061 |
| Camera position / angle | R005, R069, R082 |
