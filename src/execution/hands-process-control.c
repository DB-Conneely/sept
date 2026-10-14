/* Fixed trusted Engine-only census/join. Arbitrary commands never receive this root entry or capabilities. */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>
#include <limits.h>

struct identity { int pid; unsigned long long start; int ppid; uid_t uid; char state; };
static int own_pid;
static struct identity init, idle, resident, self;
static const char *namespace;
static void refuse(void) { _exit(126); }
static unsigned long long number(const char *text) {
    char *end = NULL;
    errno = 0;
    unsigned long long value = strtoull(text, &end, 10);
    if (text[0] == '\0' || text[0] == '-' || errno != 0 || end == NULL || *end != '\0' || value == 0) refuse();
    return value;
}
static int read_small(const char *path, char *output, size_t size) {
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) {
        if (errno == ENOENT || errno == ESRCH) return 0;
        refuse();
    }
    ssize_t count = read(fd, output, size - 1);
    int disappeared = count == 0 || (count < 0 && (errno == ESRCH || errno == ENOENT));
    if (close(fd) != 0) refuse();
    /* Proc files can vanish after open when a scanned child exits. A vanished lifetime has no effects;
       the next bounded census still sees any replacement PID and all surviving descendants. */
    if (disappeared) return 0;
    if (count < 0 || (size_t)count >= size - 1) refuse();
    output[count] = '\0';
    return (int)count;
}
static int identity(int pid, struct identity *result) {
    char path[64], content[16384];
    snprintf(path, sizeof(path), "/proc/%d/stat", pid);
    if (!read_small(path, content, sizeof(content))) return 0;
    char *closing = strrchr(content, ')');
    if (closing == NULL || closing[1] != ' ') refuse();
    char *save = NULL, *token = strtok_r(closing + 2, " ", &save);
    result->pid = pid;
    for (int index = 0; index <= 19; index++) {
        if (token == NULL) refuse();
        if (index == 0) result->state = token[0];
        if (index == 1) result->ppid = atoi(token);
        if (index == 19) result->start = number(token);
        token = strtok_r(NULL, " ", &save);
    }
    snprintf(path, sizeof(path), "/proc/%d/status", pid);
    if (!read_small(path, content, sizeof(content))) return 0;
    char *uid = strstr(content, "\nUid:\t");
    unsigned int effective;
    if (uid == NULL || sscanf(uid, "\nUid:\t%u\t%u", &result->uid, &effective) != 2 || result->uid != effective) refuse();
    return 1;
}
static void executable(int pid, const char *expected) {
    char path[64], output[256], canonical[PATH_MAX];
    snprintf(path, sizeof(path), "/proc/%d/exe", pid);
    ssize_t bytes = readlink(path, output, sizeof(output) - 1);
    if (bytes <= 0 || bytes >= (ssize_t)sizeof(output) - 1) refuse();
    output[bytes] = '\0';
    /* Debian's immutable /sbin alias resolves to /usr/sbin; compare the actual fixed image path. */
    if (realpath(expected, canonical) == NULL || strcmp(output, canonical) != 0) refuse();
}
static void check_lifetime(struct identity expected) {
    struct identity current;
    if (!identity(expected.pid, &current) || current.start != expected.start || current.state == 'Z') refuse();
}
static void check_namespace(void) {
    char output[64];
    ssize_t bytes = readlink("/proc/self/ns/pid", output, sizeof(output) - 1);
    if (bytes <= 0 || bytes >= (ssize_t)sizeof(output) - 1) refuse();
    output[bytes] = '\0';
    if (strcmp(output, namespace) != 0) refuse();
    check_lifetime(init);
    check_lifetime(resident);
    check_lifetime(self);
    if (idle.pid != 0) check_lifetime(idle);
}
static int lifetime(int pid) { return pid == 1 || pid == idle.pid || pid == resident.pid || pid == own_pid; }
static size_t census(struct identity *identities) {
    DIR *directory = opendir("/proc");
    if (directory == NULL) refuse();
    struct dirent *entry;
    size_t count = 0;
    errno = 0;
    while ((entry = readdir(directory)) != NULL) {
        char *end = NULL;
        long pid = strtol(entry->d_name, &end, 10);
        if (*entry->d_name == '\0' || *end != '\0' || pid <= 0 || pid > 2147483647L || lifetime((int)pid)) continue;
        if (count >= 4096) refuse();
        if (identity((int)pid, &identities[count])) count++;
        errno = 0;
    }
    if (errno != 0 || closedir(directory) != 0) refuse();
    return count;
}
static void capture(void) {
    struct identity identities[4096];
    size_t count = census(identities);
    if (count != 1 || identities[0].ppid != 1 || identities[0].uid != 10002 || identities[0].state == 'Z') refuse();
    idle = identities[0];
    executable(1, "/sbin/docker-init");
    executable(idle.pid, "/usr/bin/sleep");
    char path[64], content[64];
    snprintf(path, sizeof(path), "/proc/%d/cmdline", idle.pid);
    if (read_small(path, content, sizeof(content)) != 15 || memcmp(content, "sleep\0infinity\0", 15) != 0) refuse();
    check_namespace();
    printf("{\"idle\":{\"pid\":%d,\"start\":\"%llu\"}}\n", idle.pid, idle.start);
}
static void signal_exact(struct identity expected, int signal) {
    int descriptor = syscall(SYS_pidfd_open, expected.pid, 0);
    if (descriptor < 0) {
        if (errno == ESRCH) return;
        refuse();
    }
    struct identity current;
    if (identity(expected.pid, &current)) {
        if (current.start != expected.start) refuse();
        if (syscall(SYS_pidfd_send_signal, descriptor, signal, NULL, 0) != 0 && errno != ESRCH) refuse();
    }
    if (close(descriptor) != 0) refuse();
}
static void join_owned(void) {
    struct identity identities[4096];
    size_t signaled = 0;
    unsigned int clear = 0;
    struct timespec pause = { .tv_sec = 0, .tv_nsec = 10000000 };
    for (unsigned int round = 0; round < 200; round++) {
        check_namespace();
        size_t count = census(identities);
        if (count == 0) {
            if (++clear == 2) {
                printf("{\"joined\":true,\"remaining\":0,\"signaled\":%zu}\n", signaled);
                return;
            }
        } else {
            clear = 0;
            for (size_t index = 0; index < count; index++) {
                signal_exact(identities[index], round < 10 ? SIGTERM : SIGKILL);
                signaled++;
            }
        }
        if (nanosleep(&pause, NULL) != 0) refuse();
    }
    refuse();
}
int main(int argc, char **argv) {
    if (getuid() != 0 || (argc != 6 && argc != 8)) return 126;
    own_pid = getpid();
    if (!identity(own_pid, &self)) refuse();
    namespace = argv[2];
    init.pid = 1;
    init.start = number(argv[3]);
    resident.pid = (int)number(argv[4]);
    resident.start = number(argv[5]);
    struct identity current;
    if (resident.pid <= 1 || !identity(resident.pid, &current) || current.uid != 10002) refuse();
    executable(resident.pid, "/usr/local/bin/node");
    check_namespace();
    if (argc == 6 && strcmp(argv[1], "--capture") == 0) capture();
    else if (argc == 8 && strcmp(argv[1], "--join") == 0) {
        idle.pid = (int)number(argv[6]);
        idle.start = number(argv[7]);
        if (idle.pid <= 1 || idle.pid == resident.pid) refuse();
        check_namespace();
        join_owned();
    } else refuse();
    return fflush(stdout) == 0 ? 0 : 126;
}
