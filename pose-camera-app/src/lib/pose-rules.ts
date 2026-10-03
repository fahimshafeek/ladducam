/**
 * Pose-Correction Top 20 Rules Engine
 * Implements the mathematical and geometric evaluation rules from pose_correction_top20.md
 * using MediaPipe Pose Landmarks.
 */

export interface NormalizedLandmark {
	x: number;
	y: number;
	z: number;
	visibility?: number;
}

export interface PixelPoint {
	x: number;
	y: number;
	z: number;
	vis: number;
}

export interface RuleEvaluationContext {
	landmarks: NormalizedLandmark[];
	pts: PixelPoint[];
	W: number;
	H: number;
	SW: number; // Shoulder Width
	HW: number; // Hip Width
	TL: number; // Torso Length
	EM: number; // Eye-to-Mouth face size unit
	midShoulder: { x: number; y: number };
	midHip: { x: number; y: number };
	midEyes: { x: number; y: number };
	midMouth: { x: number; y: number };
	view: 'frontal' | 'three_quarter' | 'profile';
	activeRuleIds: Set<string>;
}

export interface PoseRule {
	id: string;
	category: 'framing' | 'head' | 'shoulders' | 'expression';
	issueId: string;
	issue: string;
	fix: string;
	priority: number; // Lower number = higher priority
	evaluate: (ctx: RuleEvaluationContext) => boolean;
}

// Landmark Indices according to MediaPipe Pose 33-point topology
export const LM = {
	NOSE: 0,
	LEFT_EYE_INNER: 1,
	LEFT_EYE: 2,
	LEFT_EYE_OUTER: 3,
	RIGHT_EYE_INNER: 4,
	RIGHT_EYE: 5,
	RIGHT_EYE_OUTER: 6,
	LEFT_EAR: 7,
	RIGHT_EAR: 8,
	MOUTH_LEFT: 9,
	MOUTH_RIGHT: 10,
	LEFT_SHOULDER: 11,
	RIGHT_SHOULDER: 12,
	LEFT_ELBOW: 13,
	RIGHT_ELBOW: 14,
	LEFT_WRIST: 15,
	RIGHT_WRIST: 16,
	LEFT_PINKY: 17,
	RIGHT_PINKY: 18,
	LEFT_INDEX: 19,
	RIGHT_INDEX: 20,
	LEFT_THUMB: 21,
	RIGHT_THUMB: 22,
	LEFT_HIP: 23,
	RIGHT_HIP: 24,
	LEFT_KNEE: 25,
	RIGHT_KNEE: 26,
	LEFT_ANKLE: 27,
	RIGHT_ANKLE: 28,
	LEFT_HEEL: 29,
	RIGHT_HEEL: 30,
	LEFT_FOOT_INDEX: 31,
	RIGHT_FOOT_INDEX: 32
} as const;

export function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

export function mid(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Angle of undirected line a->b vs horizontal, normalized to (-90, 90]
 */
export function lineAngle(a: { x: number; y: number }, b: { x: number; y: number }): number {
	let ang = Math.atan2(b.y - a.y, b.x - a.x) * (180 / Math.PI);
	while (ang > 90) ang -= 180;
	while (ang <= -90) ang += 180;
	return ang;
}

/**
 * Interior angle at vertex B formed by rays BA and BC, in [0, 180] degrees
 */
export function interiorAngle(
	a: { x: number; y: number },
	b: { x: number; y: number },
	c: { x: number; y: number }
): number {
	const v1x = a.x - b.x;
	const v1y = a.y - b.y;
	const v2x = c.x - b.x;
	const v2y = c.y - b.y;
	const dot = v1x * v2x + v1y * v2y;
	const mag1 = Math.hypot(v1x, v1y);
	const mag2 = Math.hypot(v2x, v2y);
	if (mag1 === 0 || mag2 === 0) return 180;
	const cosTheta = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
	return Math.acos(cosTheta) * (180 / Math.PI);
}

/**
 * 3D Yaw angle for anatomical left/right pair
 */
export function yaw(l: PixelPoint, r: PixelPoint): number {
	const dx = Math.abs(l.x - r.x);
	const dz = (r.z - l.z) * Math.sign(l.x - r.x);
	return Math.atan2(dz, Math.max(1, dx)) * (180 / Math.PI);
}

/**
 * The Top 20 Distinct & Sensitive Pose-Correction Rules
 */
export const POSE_RULES: PoseRule[] = [
	// ==================== PRIORITY 1: FRAMING ISSUES ====================
	{
		id: 'R082',
		category: 'framing',
		issueId: 'camera_roll',
		issue: 'Slanted horizon.',
		fix: 'The whole scene is tilted. Level the horizon with the on-screen grid before shooting.',
		priority: 10,
		evaluate: (ctx) => {
			const sAng = lineAngle(ctx.pts[LM.LEFT_SHOULDER], ctx.pts[LM.RIGHT_SHOULDER]);
			const hAng = lineAngle(ctx.pts[LM.LEFT_HIP], ctx.pts[LM.RIGHT_HIP]);
			const wasActive = ctx.activeRuleIds.has('R082');
			const thresh = wasActive ? 3.0 * 0.7 : 3.0; // Hysteresis

			if (Math.abs(sAng) >= thresh && Math.abs(hAng) >= thresh && Math.sign(sAng) === Math.sign(hAng)) {
				const lAnk = ctx.pts[LM.LEFT_ANKLE];
				const rAnk = ctx.pts[LM.RIGHT_ANKLE];
				if (lAnk.vis > 0.4 && rAnk.vis > 0.4) {
					const aAng = lineAngle(lAnk, rAnk);
					if (Math.abs(aAng) >= thresh && Math.sign(aAng) !== Math.sign(sAng)) {
						return false;
					}
				}
				return true;
			}
			return false;
		}
	},
	{
		id: 'R069',
		category: 'framing',
		issueId: 'headroom_too_little',
		issue: 'Head touches the top edge.',
		fix: 'There is almost no headroom. Tilt the camera up or step back to leave 5–10% space above the head.',
		priority: 15,
		evaluate: (ctx) => {
			const headTop = (ctx.midEyes.y - 1.75 * ctx.EM) / ctx.H;
			const wasActive = ctx.activeRuleIds.has('R069');
			const thresh = wasActive ? 0.04 * 1.3 : 0.04;
			return headTop < thresh;
		}
	},
	{
		id: 'R005',
		category: 'framing',
		issueId: 'no_lead_space',
		issue: 'No negative space in the gaze direction; tension.',
		fix: 'The subject looks out of the frame without space ahead of the gaze. Reframe so the subject sits on the opposite rule-of-thirds line.',
		priority: 20,
		evaluate: (ctx) => {
			const noseNormX = ctx.landmarks[LM.NOSE].x;
			const midEarX = (ctx.pts[LM.LEFT_EAR].x + ctx.pts[LM.RIGHT_EAR].x) / 2;
			const gazeDx = ctx.pts[LM.NOSE].x - midEarX;
			const wasActive = ctx.activeRuleIds.has('R005');
			const threshold = wasActive ? 0.15 * 0.7 : 0.15;

			if (noseNormX < 0.15 && gazeDx < -threshold * ctx.SW) return true;
			if (noseNormX > 0.85 && gazeDx > threshold * ctx.SW) return true;
			return false;
		}
	},

	// ==================== PRIORITY 2: FACE & HAND BLOCKING ====================
	{
		id: 'R033',
		category: 'head',
		issueId: 'hand_blocking_face',
		issue: 'Hand covers facial features.',
		fix: 'A hand covers part of the face. Lower it to the jawline or neck and touch with the fingertips only.',
		priority: 25,
		evaluate: (ctx) => {
			const halfW = (2.3 * ctx.EM * 1.1) / 2;
			const halfH = (3.5 * ctx.EM * 1.1) / 2;
			const handPts = [
				ctx.pts[LM.LEFT_WRIST],
				ctx.pts[LM.RIGHT_WRIST],
				ctx.pts[LM.LEFT_INDEX],
				ctx.pts[LM.RIGHT_INDEX]
			];
			return handPts.some(
				(p) => p.vis > 0.4 && Math.abs(p.x - ctx.midEyes.x) <= halfW && Math.abs(p.y - ctx.midEyes.y) <= halfH
			);
		}
	},

	// ==================== PRIORITY 3: HEAD & NECK ====================
	{
		id: 'R001',
		category: 'head',
		issueId: 'head_down_chin_tucked',
		issue: 'Chin tucked; neck compressed, unflattering shadows.',
		fix: 'The chin is tucked inward, which compresses the neck and creates shadows. Push the chin slightly forward and lift it toward the light to define the jawline.',
		priority: 30,
		evaluate: (ctx) => {
			const lEar = ctx.pts[LM.LEFT_EAR];
			const rEar = ctx.pts[LM.RIGHT_EAR];
			let earY: number;
			if (lEar.vis > 0.4 && rEar.vis > 0.4) {
				earY = (lEar.y + rEar.y) / 2;
			} else if (lEar.vis > 0.4) {
				earY = lEar.y;
			} else if (rEar.vis > 0.4) {
				earY = rEar.y;
			} else {
				earY = ctx.midEyes.y + 0.05 * ctx.EM;
			}
			const val = (ctx.pts[LM.NOSE].y - earY) / Math.max(10, ctx.EM);
			const wasActive = ctx.activeRuleIds.has('R001');
			const thresh = wasActive ? 0.75 * 0.7 : 0.75;
			return val > thresh;
		}
	},
	{
		id: 'R006',
		category: 'head',
		issueId: 'chin_raised_too_high',
		issue: 'Nostrils and underside of the jaw exposed.',
		fix: 'The chin is raised too far, exposing the jaw underside and nostrils. Lower it a few degrees so the forehead and eyes lead.',
		priority: 35,
		evaluate: (ctx) => {
			const lEar = ctx.pts[LM.LEFT_EAR];
			const rEar = ctx.pts[LM.RIGHT_EAR];
			let earY: number;
			if (lEar.vis > 0.4 && rEar.vis > 0.4) {
				earY = (lEar.y + rEar.y) / 2;
			} else if (lEar.vis > 0.4) {
				earY = lEar.y;
			} else if (rEar.vis > 0.4) {
				earY = rEar.y;
			} else {
				earY = ctx.midEyes.y + 0.05 * ctx.EM;
			}
			const val = (ctx.pts[LM.NOSE].y - earY) / Math.max(10, ctx.EM);
			const wasActive = ctx.activeRuleIds.has('R006');
			const thresh = wasActive ? 0.1 * 1.3 : 0.1;
			return val < thresh;
		}
	},
	{
		id: 'R007',
		category: 'head',
		issueId: 'head_roll_excessive',
		issue: 'Unintentional head tilt; off-balance frame.',
		fix: 'The head is canted. Level it, or tilt deliberately 5–8° toward the lower shoulder for a relaxed look.',
		priority: 40,
		evaluate: (ctx) => {
			const lEar = ctx.pts[LM.LEFT_EAR];
			const rEar = ctx.pts[LM.RIGHT_EAR];
			if (lEar.vis > 0.4 && rEar.vis > 0.4) {
				const ang = Math.abs(lineAngle(lEar, rEar));
				const wasActive = ctx.activeRuleIds.has('R007');
				const thresh = wasActive ? 8.0 * 0.7 : 8.0;
				return ang > thresh;
			}
			const ang = Math.abs(lineAngle(ctx.pts[LM.LEFT_EYE], ctx.pts[LM.RIGHT_EYE]));
			const wasActive = ctx.activeRuleIds.has('R007');
			const thresh = wasActive ? 8.0 * 0.7 : 8.0;
			return ang > thresh;
		}
	},
	{
		id: 'R011',
		category: 'head',
		issueId: 'shoulder_shrug_neck_compressed',
		issue: 'Neck disappears; tense posture.',
		fix: 'The shoulders are hiked up. Inhale, then drop the shoulders down and away from the ears as you exhale.',
		priority: 45,
		evaluate: (ctx) => {
			const lSh = ctx.pts[LM.LEFT_SHOULDER];
			const rSh = ctx.pts[LM.RIGHT_SHOULDER];
			if (lSh.vis < 0.45 || rSh.vis < 0.45) return false;

			const lEar = ctx.pts[LM.LEFT_EAR];
			const rEar = ctx.pts[LM.RIGHT_EAR];
			let earY: number;
			if (lEar.vis > 0.35 && rEar.vis > 0.35) {
				earY = (lEar.y + rEar.y) / 2;
			} else {
				earY = ctx.midEyes.y + 0.05 * ctx.EM;
			}

			const shMeanY = (lSh.y + rSh.y) / 2;
			const vertOffset = shMeanY - earY;
			const ratio = vertOffset / Math.max(10, ctx.SW);
			const wasActive = ctx.activeRuleIds.has('R011');
			const thresh = wasActive ? 0.25 * 0.7 : 0.25;
			return ratio < thresh;
		}
	},

	// ==================== PRIORITY 4: SHOULDERS & TORSO ====================
	{
		id: 'R002',
		category: 'shoulders',
		issueId: 'uneven_shoulders',
		issue: 'Unbalanced, tense posture.',
		fix: 'The shoulders are unbalanced. Relax and drop the higher shoulder, or shift weight to the back foot to even the stance.',
		priority: 50,
		evaluate: (ctx) => {
			const lSh = ctx.pts[LM.LEFT_SHOULDER];
			const rSh = ctx.pts[LM.RIGHT_SHOULDER];
			if (lSh.vis < 0.45 || rSh.vis < 0.45) return false;

			const diff = Math.abs(lSh.y - rSh.y) / Math.max(10, ctx.SW);
			const wasActive = ctx.activeRuleIds.has('R002');
			const thresh = wasActive ? 0.06 * 0.7 : 0.06;
			return diff > thresh;
		}
	},
	{
		id: 'R021',
		category: 'shoulders',
		issueId: 'torso_lean_sideways',
		issue: 'One side of the waist is shortened.',
		fix: 'The torso leans sideways. Center the ribcage over the hips, or lean on a prop so the line looks deliberate.',
		priority: 55,
		evaluate: (ctx) => {
			if (ctx.activeRuleIds.has('R082')) return false;
			if (ctx.pts[LM.LEFT_HIP].vis < 0.45 || ctx.pts[LM.RIGHT_HIP].vis < 0.45) return false;

			const dx = ctx.midShoulder.x - ctx.midHip.x;
			const dy = ctx.midShoulder.y - ctx.midHip.y;
			const angleVsVert = Math.abs(Math.atan2(Math.abs(dx), -dy) * (180 / Math.PI));
			const wasActive = ctx.activeRuleIds.has('R021');
			const thresh = wasActive ? 5.0 * 0.7 : 5.0;
			return angleVsVert > thresh;
		}
	},
	{
		id: 'R023',
		category: 'shoulders',
		issueId: 'hips_tilted_uneven',
		issue: 'Crooked hips with level shoulders look accidental.',
		fix: 'The hips tilt while the shoulders stay level. Share the weight evenly, or tilt the shoulders slightly the opposite way for a deliberate S-curve.',
		priority: 60,
		evaluate: (ctx) => {
			if (ctx.pts[LM.LEFT_HIP].vis < 0.45 || ctx.pts[LM.RIGHT_HIP].vis < 0.45) return false;
			const hipDiff = Math.abs(ctx.pts[LM.LEFT_HIP].y - ctx.pts[LM.RIGHT_HIP].y) / Math.max(10, ctx.SW);
			const shAng = Math.abs(lineAngle(ctx.pts[LM.LEFT_SHOULDER], ctx.pts[LM.RIGHT_SHOULDER]));
			const wasActive = ctx.activeRuleIds.has('R023');
			const thresh = wasActive ? 0.06 * 0.7 : 0.06;
			return hipDiff > thresh && shAng < 3.0;
		}
	},
	{
		id: 'R027',
		category: 'shoulders',
		issueId: 'torso_twisted_vs_hips',
		issue: 'Waist creasing and twisted look.',
		fix: 'The shoulders twist away from the hips. Reduce the twist to about 15° or rotate hips and shoulders together.',
		priority: 65,
		evaluate: (ctx) => {
			if (ctx.pts[LM.LEFT_HIP].vis < 0.45 || ctx.pts[LM.RIGHT_HIP].vis < 0.45) return false;
			const sYaw = yaw(ctx.pts[LM.LEFT_SHOULDER], ctx.pts[LM.RIGHT_SHOULDER]);
			const hYaw = yaw(ctx.pts[LM.LEFT_HIP], ctx.pts[LM.RIGHT_HIP]);
			const diff = Math.abs(sYaw - hYaw);
			const wasActive = ctx.activeRuleIds.has('R027');
			const thresh = wasActive ? 15.0 * 0.7 : 15.0;
			return diff > thresh;
		}
	},

	// ==================== PRIORITY 5: ARMS & HANDS ====================
	{
		id: 'R031',
		category: 'expression',
		issueId: 'arms_crossed_closed',
		issue: 'Defensive, closed body language.',
		fix: 'Crossed arms look defensive. Rest one hand lightly on the opposite elbow and relax the other arm, or put a hand in a pocket with the thumb out.',
		priority: 70,
		evaluate: (ctx) => {
			const lW = ctx.pts[LM.LEFT_WRIST];
			const rW = ctx.pts[LM.RIGHT_WRIST];
			if (lW.vis < 0.4 || rW.vis < 0.4) return false;

			const isLeftShGreaterX = ctx.pts[LM.LEFT_SHOULDER].x > ctx.midShoulder.x;
			const wasActive = ctx.activeRuleIds.has('R031');
			const margin = (wasActive ? 0.1 * 0.7 : 0.1) * ctx.SW;

			const leftCrossed = isLeftShGreaterX
				? lW.x < ctx.midShoulder.x - margin
				: lW.x > ctx.midShoulder.x + margin;
			const rightCrossed = isLeftShGreaterX
				? rW.x > ctx.midShoulder.x + margin
				: rW.x < ctx.midShoulder.x - margin;

			const minY = Math.min(ctx.pts[LM.LEFT_SHOULDER].y, ctx.pts[LM.RIGHT_SHOULDER].y) - 0.15 * ctx.SW;
			const maxY = Math.max(ctx.pts[LM.LEFT_HIP].y, ctx.pts[LM.RIGHT_HIP].y) + 0.15 * ctx.SW;
			const inYRange = lW.y >= minY && lW.y <= maxY && rW.y >= minY && rW.y <= maxY;

			return leftCrossed && rightCrossed && inYRange;
		}
	},
	{
		id: 'R034',
		category: 'expression',
		issueId: 'hands_clasped_fig_leaf',
		issue: 'Stiff, formal, blocks the torso center.',
		fix: 'Both hands are clasped in front, which looks stiff. Separate them: one in a pocket or holding an accessory, the other relaxed.',
		priority: 75,
		evaluate: (ctx) => {
			const lW = ctx.pts[LM.LEFT_WRIST];
			const rW = ctx.pts[LM.RIGHT_WRIST];
			if (lW.vis < 0.4 || rW.vis < 0.4) return false;

			const wDist = dist(lW, rW);
			const midW = mid(lW, rW);
			const wasActive = ctx.activeRuleIds.has('R034');
			const distThresh = (wasActive ? 0.2 * 1.3 : 0.2) * ctx.SW;

			return (
				wDist < distThresh &&
				Math.abs(midW.y - ctx.midHip.y) <= 0.25 * ctx.TL &&
				Math.abs(midW.x - ctx.midHip.x) < 0.25 * ctx.SW
			);
		}
	},
	{
		id: 'R043',
		category: 'expression',
		issueId: 'both_hands_on_hips_symmetric',
		issue: 'Symmetric akimbo looks rigid and aggressive.',
		fix: 'Both hands on the hips make a rigid shape. Use one hand on the hip and let the other arm hang or hold something.',
		priority: 80,
		evaluate: (ctx) => {
			const lW = ctx.pts[LM.LEFT_WRIST];
			const rW = ctx.pts[LM.RIGHT_WRIST];
			if (lW.vis < 0.4 || rW.vis < 0.4) return false;

			const lDist = dist(lW, ctx.pts[LM.LEFT_HIP]);
			const rDist = dist(rW, ctx.pts[LM.RIGHT_HIP]);
			const wasActive = ctx.activeRuleIds.has('R043');
			const maxDist = (wasActive ? 0.25 * 1.3 : 0.25) * ctx.SW;

			if (lDist < maxDist && rDist < maxDist) {
				const lElbAng = interiorAngle(ctx.pts[LM.LEFT_SHOULDER], ctx.pts[LM.LEFT_ELBOW], lW);
				const rElbAng = interiorAngle(ctx.pts[LM.RIGHT_SHOULDER], ctx.pts[LM.RIGHT_ELBOW], rW);
				return lElbAng < 150 && rElbAng < 150;
			}
			return false;
		}
	},

	// ==================== PRIORITY 6: LEGS & STANCE ====================
	{
		id: 'R045',
		category: 'shoulders',
		issueId: 'locked_knees',
		issue: 'Rigid, locked legs.',
		fix: 'The knees are locked straight. Soften one knee with a slight bend and shift weight onto the other leg.',
		priority: 85,
		evaluate: (ctx) => {
			const lK = ctx.pts[LM.LEFT_KNEE];
			const rK = ctx.pts[LM.RIGHT_KNEE];
			const lA = ctx.pts[LM.LEFT_ANKLE];
			const rA = ctx.pts[LM.RIGHT_ANKLE];
			if (lK.vis < 0.45 || rK.vis < 0.45 || lA.vis < 0.45 || rA.vis < 0.45) return false;

			const lAng = interiorAngle(ctx.pts[LM.LEFT_HIP], lK, lA);
			const rAng = interiorAngle(ctx.pts[LM.RIGHT_HIP], rK, rA);
			const wasActive = ctx.activeRuleIds.has('R045');
			const thresh = wasActive ? 172.0 * 0.7 : 172.0;

			return lAng > thresh && rAng > thresh;
		}
	},
	{
		id: 'R046',
		category: 'shoulders',
		issueId: 'stance_too_wide',
		issue: 'Wide stance broadens the hips.',
		fix: 'The feet are planted too wide. Narrow to hip width and put one foot slightly in front of the other.',
		priority: 90,
		evaluate: (ctx) => {
			if (ctx.view !== 'frontal') return false;
			const lA = ctx.pts[LM.LEFT_ANKLE];
			const rA = ctx.pts[LM.RIGHT_ANKLE];
			if (lA.vis < 0.45 || rA.vis < 0.45) return false;

			const ankDist = dist(lA, rA);
			const wasActive = ctx.activeRuleIds.has('R046');
			const thresh = (wasActive ? 2.4 * 0.7 : 2.4) * ctx.HW;

			return ankDist > thresh;
		}
	},
	{
		id: 'R047',
		category: 'shoulders',
		issueId: 'feet_together_stiff',
		issue: 'Attention stance looks stiff.',
		fix: 'The feet are pressed together. Step one foot forward, angle it about 45°, and put weight on the back foot.',
		priority: 95,
		evaluate: (ctx) => {
			if (ctx.view !== 'frontal') return false;
			const lA = ctx.pts[LM.LEFT_ANKLE];
			const rA = ctx.pts[LM.RIGHT_ANKLE];
			if (lA.vis < 0.45 || rA.vis < 0.45) return false;

			const ankDist = dist(lA, rA);
			const wasActive = ctx.activeRuleIds.has('R047');
			const thresh = (wasActive ? 0.8 * 1.3 : 0.8) * ctx.HW;

			return ankDist < thresh;
		}
	},

	// ==================== PRIORITY 7: BODY ORIENTATION ====================
	{
		id: 'R061',
		category: 'framing',
		issueId: 'over_rotated_body',
		issue: 'Chest line lost; twisted look.',
		fix: 'The body is turned too far from the camera. Rotate back to about 30–45° so the chest and shoulders still show.',
		priority: 100,
		evaluate: (ctx) => {
			const lEarVis = ctx.pts[LM.LEFT_EAR].vis;
			const rEarVis = ctx.pts[LM.RIGHT_EAR].vis;
			if (lEarVis < 0.5 || rEarVis < 0.5) return false;

			const wasActive = ctx.activeRuleIds.has('R061');

			if (ctx.pts[LM.LEFT_HIP].vis > 0.45 && ctx.pts[LM.RIGHT_HIP].vis > 0.45) {
				const ratio = ctx.SW / Math.max(10, ctx.TL);
				const thresh = wasActive ? 0.35 * 1.3 : 0.35;
				return ratio < thresh;
			}
			const sYaw = Math.abs(yaw(ctx.pts[LM.LEFT_SHOULDER], ctx.pts[LM.RIGHT_SHOULDER]));
			const threshYaw = wasActive ? 55.0 * 0.8 : 55.0;
			return sYaw > threshYaw;
		}
	},
	{
		id: 'R004',
		category: 'framing',
		issueId: 'body_square_to_camera',
		issue: 'Overly broad, static look.',
		fix: 'The subject is square to the lens, which looks broad and static. Pivot the body 45° away from the camera and turn the face back toward the lens.',
		priority: 105,
		evaluate: (ctx) => {
			if (ctx.pts[LM.LEFT_SHOULDER].vis < 0.5 || ctx.pts[LM.RIGHT_SHOULDER].vis < 0.5) return false;

			const sYaw = Math.abs(yaw(ctx.pts[LM.LEFT_SHOULDER], ctx.pts[LM.RIGHT_SHOULDER]));
			const wasActive = ctx.activeRuleIds.has('R004');

			if (ctx.pts[LM.LEFT_HIP].vis > 0.45 && ctx.pts[LM.RIGHT_HIP].vis > 0.45) {
				const ratio = ctx.SW / Math.max(10, ctx.TL);
				const thresh = wasActive ? 0.74 * 0.7 : 0.74;
				return ratio >= thresh && sYaw < 22;
			}

			const threshYaw = wasActive ? 15.0 * 0.7 : 15.0;
			return sYaw < threshYaw;
		}
	}
];

export function createEvaluationContext(
	landmarks: NormalizedLandmark[],
	width: number,
	height: number,
	activeRuleIds: Set<string> = new Set()
): RuleEvaluationContext {
	const pts: PixelPoint[] = landmarks.map((l) => ({
		x: l.x * width,
		y: l.y * height,
		z: (l.z ?? 0) * width,
		vis: l.visibility ?? 1
	}));

	const lShoulder = pts[LM.LEFT_SHOULDER] || { x: 0, y: 0, z: 0, vis: 0 };
	const rShoulder = pts[LM.RIGHT_SHOULDER] || { x: 0, y: 0, z: 0, vis: 0 };
	const lHip = pts[LM.LEFT_HIP] || { x: 0, y: 0, z: 0, vis: 0 };
	const rHip = pts[LM.RIGHT_HIP] || { x: 0, y: 0, z: 0, vis: 0 };
	const lEye = pts[LM.LEFT_EYE] || { x: 0, y: 0, z: 0, vis: 0 };
	const rEye = pts[LM.RIGHT_EYE] || { x: 0, y: 0, z: 0, vis: 0 };
	const lMouth = pts[LM.MOUTH_LEFT] || { x: 0, y: 0, z: 0, vis: 0 };
	const rMouth = pts[LM.MOUTH_RIGHT] || { x: 0, y: 0, z: 0, vis: 0 };

	const midShoulder = mid(lShoulder, rShoulder);
	const midHip = mid(lHip, rHip);
	const midEyes = mid(lEye, rEye);
	const midMouth = mid(lMouth, rMouth);

	const SW = dist(lShoulder, rShoulder);
	const HW = dist(lHip, rHip);
	const TL = dist(midShoulder, midHip);
	const EM = dist(midEyes, midMouth);

	// View estimation
	let view: 'frontal' | 'three_quarter' | 'profile' = 'frontal';
	const shoulderRatio = SW / Math.max(1, TL);
	const lEarVis = pts[LM.LEFT_EAR]?.vis ?? 0;
	const rEarVis = pts[LM.RIGHT_EAR]?.vis ?? 0;

	if (shoulderRatio < 0.35 || (lEarVis < 0.3 && rEarVis > 0.6) || (rEarVis < 0.3 && lEarVis > 0.6)) {
		view = 'profile';
	} else if (shoulderRatio < 0.65 || Math.abs(lEarVis - rEarVis) > 0.3) {
		view = 'three_quarter';
	} else {
		view = 'frontal';
	}

	return {
		landmarks,
		pts,
		W: width,
		H: height,
		SW,
		HW,
		TL,
		EM,
		midShoulder,
		midHip,
		midEyes,
		midMouth,
		view,
		activeRuleIds
	};
}

export function evaluateTopRule(ctx: RuleEvaluationContext): PoseRule | null {
	// Sorted by priority ascending (lowest number = highest priority)
	const sorted = [...POSE_RULES].sort((a, b) => a.priority - b.priority);
	for (const rule of sorted) {
		try {
			if (rule.evaluate(ctx)) {
				return rule;
			}
		} catch (e) {
			console.warn(`[PoseRule] Error evaluating ${rule.id}:`, e);
		}
	}
	return null;
}
