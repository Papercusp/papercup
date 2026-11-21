#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t stopping;
static void stop(int sig) { stopping = sig; }

static long milliseconds(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1000L + t.tv_nsec / 1000000L;
}

/* These are direct children of this single-threaded subreaper. No thread
 * can reap or recycle their PIDs between reading this list and signalling. */
static int signal_children(int sig) {
    char path[96];
    snprintf(path, sizeof(path), "/proc/self/task/%ld/children", (long)getpid());
    FILE *children = fopen(path, "r");
    if (!children) return -1;
    int pid;
    while (fscanf(children, "%d", &pid) == 1) kill(pid, sig);
    fclose(children);
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2 || prctl(PR_SET_CHILD_SUBREAPER, 1) < 0) {
        perror("psu-acp supervisor");
        return 1;
    }
    struct sigaction action = {.sa_handler = stop};
    sigaction(SIGTERM, &action, NULL);
    sigaction(SIGHUP, &action, NULL);
    sigaction(SIGINT, &action, NULL);
    pid_t primary = fork();
    if (primary < 0) { perror("psu-acp fork"); return 1; }
    if (primary == 0) {
        execvp(argv[1], argv + 1);
        perror("psu-acp exec");
        _exit(127);
    }
    int status = 0, result = 1;
    long requested = 0, cleanup = 0;
    while (1) {
        pid_t pid = waitpid(-1, &status, WNOHANG);
        if (pid > 0) {
            if (pid == primary) {
                result = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
                cleanup = milliseconds();
            }
            continue;
        }
        if (pid < 0 && errno == ECHILD) break;
        long now = milliseconds();
        if (stopping && !requested && !cleanup) {
            requested = now;
            kill(primary, SIGTERM);
        }
        if (requested && !cleanup && now - requested > 2000) kill(primary, SIGKILL);
        if (cleanup && signal_children(now - cleanup < 800 ? SIGTERM : SIGKILL) < 0) {
            perror("psu-acp child inventory"); return 1;
        }
        usleep(20000);
    }
    return result;
}
