# Privacy

This page describes data handling in the OpenDesign desktop and web app.

OpenDesign is **local-first**: the local app stores project files, conversations,
configuration, and provider credentials on your machine. Local-first does not
mean offline; the features you use determine which services receive data.

## No application analytics or telemetry reporting

OpenDesign does not send application usage events, exported traces, session
recordings, or automatic crash reports to the OpenDesign team or third-party
analytics services. The application analytics exporters and their consent
settings have been removed.

Local run diagnostics, logs, and crash-recovery information remain available
for troubleshooting. A manually requested diagnostics export is saved locally;
you decide whether to share that file and with whom.

## Model providers and coding agents

When you run a task through a cloud model provider or coding agent, that service
receives the prompts, conversation context, attachments, or project content
needed for the task. The provider or agent may also access project files through
the tools you authorize. Its own data-handling policy applies.

Bring-your-own-key credentials are stored locally and used to authenticate
requests to the provider you configure. Removing analytics does not remove
these authenticated requests or change the behavior of separately installed
coding agents.

## Other network features

Updates, catalog downloads, connectors, and other network-backed features
contact their configured services. Publishing, deployment, and sharing send the
selected content to the destination you choose. These functional requests are
separate from application analytics and are not disabled by telemetry removal.

## Changes to this page

This document tracks the data handling of the shipped app. When that behavior
changes, this page is updated alongside it. For questions, open a
[GitHub Discussion](https://github.com/nexu-io/open-design/discussions).
