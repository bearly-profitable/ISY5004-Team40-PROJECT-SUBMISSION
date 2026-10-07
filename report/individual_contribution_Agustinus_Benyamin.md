# Individual Accomplishment and Contribution

**Agustinus Benyamin Prasetyo**
Group 40 · Lumina
Teammate: Ong Qing Quan

Lumina takes a batch of personal photos, groups them into events and people, and picks a best shot of each person at each event. I designed the original Semester 1 model, then owned the evaluation and the human study that decided what the Semester 2 model should change.

## Semester 1 model

The first prototype already detected people, embedded faces and bodies, grouped scenes, and ranked photos with seven hand-set quality signals. Measuring that prototype set the problem for the capstone. Body-only clustering did not separate people well. Adding who appeared in a photo barely helped event grouping. The eye-open term never changed which photo won, which meant the term had no usable range, not that blinks do not matter. Those three findings are why the later model fuses face and body by confidence, clusters events from scene and time only, and treats a blink as a hard constraint.

## Model Evaluation

I built a harness that runs the real pipeline on a private set of 55 photographs in 20 occasions, caches the embeddings, and re-scores identity, events, ranking and preference learning from the same code the app uses. The run produced the numbers in the technical paper:

- Fused identity clustering made none of the 526 merges that would put two faces from one photo in the same person. Clustering the body alone made 85 of them.
- The label-free event threshold reached an adjusted Rand index of 0.985 against the folder grouping, against 0.549 for the Semester 1 event features.
- Dropping the blink constraint let a closed-eye frame win on 3 of 16 occasions that had an eyes-open alternative. An aesthetic score on its own disagreed with the full ranker on 12 of 16 winners.

Two app settings changed because of that run. The preference learning rate went from 0.35 to 0.2, because the larger step overshot for users already close to the defaults. The event-threshold search became a fine grid from 0.05 to 1.0, because the old step of 0.25 jumped past the silhouette peak and split events that belonged together. The same run also fixed a scoring bug: under NumPy 2, aesthetic scores were stored as zero and then reused from cache.

## Human Study

I designed a study in which a person only chooses which photo they would keep. Thirteen people finished it, giving 234 picks across 18 questions. Lumina’s displayed order scored 0.53 against 0.50 for a random pick: above chance, and too small a margin to keep one frame and delete the rest without a stated reason. People disagreed with each other, and the same person sometimes changed their answer on a repeated question. One pass of preference learning did not raise agreement on held-out occasions. On one occasion every tester kept the wide shot of the whole party, which the ranker had placed last. That is a signal the seven weights do not have yet.

## Technical Paper

I wrote the technical paper that states the model, reports these measurements, and says what they do not show.