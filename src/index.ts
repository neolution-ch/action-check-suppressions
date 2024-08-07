import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as github from "@actions/github";
import * as fs from "fs";
import { minimatch } from "minimatch";

const allowedCsSuppressions = [
  "CA1310",
  "S107",
  "S134",
  "S138",
  "S1067",
  "S1192",
  "S1200",
  "S1821",
  "S3240",
  "S3776",
  "S4040",
  "S4462",
];
const allowedTsSuppressions = [
  "@typescript-eslint/naming-convention",
  "complexity",
  "no-console",
  "no-floating-promises",
  "no-param-reassign",
  "no-unnecessary-condition",
  "react/jsx-props-no-spreading",
  "react/no-array-index-key",
  "react/no-unused-prop-types",
  "react-hooks/exhaustive-deps",
  "max-lines",
];
const commentPrefix = "[action-check-suppressions]";
const commentSuppressionWarning = "Suppressions should not be used, please make sure with the Project Team that this suppression is ok.";
const commentSuppressionNotAllowed = "This suppression is not allowed, please remove it.";

/**
 * The main entry point
 */
async function run(): Promise<void> {
  try {
    const { context } = github;

    if (!context.payload.pull_request) {
      core.info("===> Not a Pull Request, skipping");
      return;
    }

    const githubToken = core.getInput("GITHUB_TOKEN", { required: true });
    const continueOnError = core.getBooleanInput("continueOnError");
    const ignoredPaths = core.getMultilineInput("ignoredPaths");
    const pullRequestNumber = context.payload.pull_request.number;

    const octokit = github.getOctokit(githubToken);

    const { data: reviewComments } = await octokit.rest.pulls.listReviewComments({
      ...context.repo,
      pull_number: pullRequestNumber, // eslint-disable-line @typescript-eslint/naming-convention
    }).catch((error: unknown) => {
      throw new Error(`Unable to get review comments: ${error as string}`);
    });

    // Delete existing comments
    for (const reviewComment of reviewComments) {
      if (reviewComment.user.login !== "github-actions[bot]") {
        return;
      }

      if (!reviewComment.body.includes(commentPrefix)) {
        return;
      }

      await octokit.rest.pulls.deleteReviewComment({
        ...context.repo,
        comment_id: reviewComment.id, // eslint-disable-line @typescript-eslint/naming-convention
      }).catch((error: unknown) => {
        throw new Error(`Unable to delete review comment: ${error as string}`);
      });
    }

    const { data: prDetails } = await octokit.rest.pulls.get({
      ...context.repo,
      pull_number: pullRequestNumber, // eslint-disable-line @typescript-eslint/naming-convention
    }).catch((error: unknown) => {
      throw new Error(`Unable to get pull request info: ${error as string}`);
    });

    // Fetch relevant commits
    await exec.exec("git", ["fetch", "--no-tags", "--prune", "--no-recurse-submodules", "--depth=1", "origin", `${prDetails.base.sha}`], { silent: true });
    await exec.exec("git", ["fetch", "--no-tags", "--prune", "--no-recurse-submodules", "--depth=1", "origin", `${prDetails.head.sha}`], { silent: true });

    // Get the unified diff
    const { stdout: prDiff } = await exec.getExecOutput("git", ["diff", "--unified=0", `${prDetails.base.sha}`, `${prDetails.head.sha}`], { silent: true });

    let suppressionNotAllowedDetected = false;
    let filename = "";
    let lineNr = 0;

    const writePullRequestComment = async (comment: string): Promise<void> => {
      await octokit.rest.pulls.createReviewComment({
        ...context.repo,
        pull_number: pullRequestNumber, // eslint-disable-line @typescript-eslint/naming-convention
        commit_id: prDetails.head.sha, // eslint-disable-line @typescript-eslint/naming-convention
        body: `${commentPrefix}\n${comment}`,
        path: filename,
        line: lineNr,
      }).catch((error: unknown) => {
        throw new Error(`Unable to create review comment: ${error as string}`);
      });
    };

    const handleSuppression = async (line: string): Promise<void> => {
      for (const ignoredPath of ignoredPaths) {
        if (minimatch(filename, ignoredPath)) {
          core.info("===> File matches the ignored paths");
          return;
        }
      }

      if (filename.endsWith("GlobalSuppressions.cs")) {
        core.info("===> Suppression/Pragma allowed in GlobalSuppressions.cs");
        await writePullRequestComment(commentSuppressionWarning);
        return;
      }

      if (filename.endsWith(".editorconfig")) {
        core.info("===> Suppression/Pragma allowed in editorconfig");
        await writePullRequestComment(commentSuppressionWarning);
        return;
      }

      const fileContent = fs.readFileSync(filename, "utf8");
      if (fileContent.includes("// <auto-generated")) {
        core.info("===> Suppression/Pragma allowed in auto-generated file");
        return;
      }

      // Create a regex by adding the word boundary around each entry and separate
      // them with the or clause
      const allowedCsSuppressionsRegex = new RegExp(`\b${allowedCsSuppressions.join("\\b|\\b")}\b`);
      const allowedTsSuppressionsRegex = new RegExp(`\b${allowedTsSuppressions.join("\\b|\\b")}\b`);

      if (allowedCsSuppressionsRegex.test(line) || allowedTsSuppressionsRegex.test(line)) {
        core.info("===> Suppression allowed, add comment to PR");
        await writePullRequestComment(commentSuppressionWarning);
      } else {
        core.info("===> Suppression not allowed");
        await writePullRequestComment(commentSuppressionNotAllowed);
        suppressionNotAllowedDetected = true;
      }
    };

    const lines = prDiff.split(/\r?\n/);
    for (const line of lines) {
      // Skip lines not starting with + or @
      if (!(line.startsWith("+") || line.startsWith("@"))) {
        continue;
      }

      // Match the filename
      if (line.startsWith("+++ b")) {
        filename = line.substring(6);
        continue;
      }

      // Match the line number
      if (line.startsWith("@@")) {
        const match = /^@@ -[0-9]+,?[0-9]* \+([0-9]+),?[0-9]* @@.*/.exec(line);
        if (match == null) {
          throw new Error("Unable to parse line number");
        }

        lineNr = parseInt(match[1], 10);
        continue;
      }

      // Match the suppressions
      if (line.includes("SuppressMessage(")) {
        core.info(`Detected 'SuppressMessage' in file '${filename}' at line ${lineNr}`);
        await handleSuppression(line);
      } else if (line.includes("#pragma warning disable")) {
        core.info(`Detected '#pragma warning disable' in file '${filename}' at line ${lineNr}`);
        await handleSuppression(line);
      } else if (line.includes("tslint:disable")) {
        core.info(`Detected 'tslint:disable' in file '${filename}' at line ${lineNr}`);
        await handleSuppression(line);
      } else if (line.includes("eslint-disable")) {
        core.info(`Detected 'eslint-disable' in file '${filename}' at line ${lineNr}`);
        await handleSuppression(line);
      } else if (line.includes("@ts-expect-error")) {
        core.info(`Detected '@ts-expect-error' in file '${filename}' at line ${lineNr}`);
        await handleSuppression(line);
      } else if (line.includes("@ts-ignore")) {
        core.info(`Detected '@ts-ignore' in file '${filename}' at line ${lineNr}`);
        await handleSuppression(line);
      } else if (/dotnet_diagnostic\..*\.severity/.exec(line)) {
        core.info(`Detected 'dotnet_diagnostic.*.severity' in file '${filename}' at line ${lineNr}`);
        await handleSuppression(line);
      }

      lineNr += 1;
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!continueOnError && suppressionNotAllowedDetected) {
      throw new Error("Detected not allowed suppression (continueOnError = false)");
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error);
    } else {
      core.setFailed(`Unexpected error: ${error as string}`);
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
run();
