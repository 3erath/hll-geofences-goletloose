FROM golang:1.26-alpine AS build

WORKDIR /src

COPY go.mod ./
COPY main.go ./

RUN go mod tidy
RUN go build -o app main.go

FROM alpine:3.20

WORKDIR /app
COPY --from=build /src/app .

ENTRYPOINT ["/app/app"]
