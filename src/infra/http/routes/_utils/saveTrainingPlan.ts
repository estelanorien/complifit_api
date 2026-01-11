import { TrainingPlan } from '../../../../application/services/trainingService';

export const saveTrainingProgram = async (
  client: any,
  userId: string,
  trainingPlan: TrainingPlan,
  startDate?: string,
  options?: { isRecovery?: boolean }
) => {
  const trainingId = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
  await client.query(
    `INSERT INTO training_programs(id, user_id, name, analysis, training_style, is_recovery, created_at)
     VALUES($1,$2,$3,$4,$5,$6,now())`,
    [
      trainingId,
      userId,
      trainingPlan?.name || 'Training Plan',
      trainingPlan?.analysis || '',
      trainingPlan?.trainingStyle || 'standard',
      options?.isRecovery || false
    ]
  );

  if (Array.isArray(trainingPlan?.schedule)) {
    for (let i = 0; i < trainingPlan.schedule.length; i++) {
      const day = trainingPlan.schedule[i];
      const dayId = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
      await client.query(
        `INSERT INTO training_days(id, training_program_id, day_index, focus)
         VALUES($1,$2,$3,$4)
         ON CONFLICT (training_program_id, day_index) DO NOTHING`,
        [dayId, trainingId, i, day.focus || day.day || `Day ${i + 1}`]
      );
      if (Array.isArray(day.exercises)) {
        for (const ex of day.exercises) {
          await client.query(
            `INSERT INTO training_exercises(id, training_day_id, name, sets, reps, notes, target_muscles, equipment, difficulty, metadata, created_at)
             VALUES(gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
            [
              dayId,
              ex.name || 'Exercise',
              ex.sets || '',
              ex.reps || '',
              ex.notes || ex.drillContext || '',
              Array.isArray(ex.targetMuscles) ? ex.targetMuscles : (ex.targetMuscles ? [ex.targetMuscles] : null),
              ex.equipment || null,
              ex.difficulty || null,
              JSON.stringify(ex)
            ]
          );
        }
      }
    }
  }

  // Get current profile_data to preserve all existing data
  const { rows: profileRows } = await client.query(
    `SELECT profile_data FROM user_profiles WHERE user_id = $1`,
    [userId]
  );

  const currentProfileData = profileRows.length > 0 ? (profileRows[0].profile_data || {}) : {};

  // Update only training program related fields, preserve everything else
  const updatedProfileData = {
    ...currentProfileData,
    currentTrainingProgram: trainingPlan,
    trainingProgramStartDate: startDate || new Date().toISOString().split('T')[0]
  };

  await client.query(
    `UPDATE user_profiles
     SET profile_data = $1::jsonb,
         updated_at = now()
     WHERE user_id = $2`,
    [JSON.stringify(updatedProfileData), userId]
  );

  return trainingId;
};


