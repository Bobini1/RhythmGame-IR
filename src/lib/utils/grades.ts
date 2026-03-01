const GRADE_THRESHOLDS = [1, 8.5 / 9, 8 / 9, 7.5 / 9, 7 / 9, 6.5 / 9, 6 / 9, 5.5 / 9, 5 / 9, 4 / 9, 3 / 9, 2 / 9, 0] as const;
const GRADE_LABELS = ['MAX', 'MAX-', 'AAA', 'AAA-', 'AA', 'AA-', 'A', 'A-', 'B', 'C', 'D', 'E', 'F'] as const;

export type Grade = (typeof GRADE_LABELS)[number];

export function getGrade(points: number, maxPoints: number): Grade {
	if (maxPoints <= 0) return 'F';
	const ratio = points / maxPoints;
	for (let i = 0; i < GRADE_THRESHOLDS.length; i++) {
		if (ratio >= GRADE_THRESHOLDS[i]) {
			return GRADE_LABELS[i];
		}
	}
	return 'F';
}

export function getGradeColor(grade: Grade): string {
	switch (grade) {
		case 'MAX':
		case 'MAX-':
			return 'text-yellow-400';
		case 'AAA':
		case 'AAA-':
			return 'text-orange-400';
		case 'AA':
		case 'AA-':
			return 'text-sky-400';
		case 'A':
		case 'A-':
			return 'text-green-400';
		case 'B':
			return 'text-teal-400';
		case 'C':
			return 'text-indigo-400';
		case 'D':
			return 'text-purple-400';
		case 'E':
			return 'text-pink-400';
		case 'F':
			return 'text-red-400';
	}
}

