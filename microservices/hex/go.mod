module urban/microservices/hex

go 1.25.0

// Local modules. The replace directives let `docker build` work without
// copying go.work into the image.
require (
	urban/gen v0.0.0
	urban/pkg v0.0.0
)

replace urban/gen => ../../gen

replace urban/pkg => ../../pkg

require google.golang.org/grpc v1.83.1

require (
	golang.org/x/net v0.55.0 // indirect
	golang.org/x/sys v0.45.0 // indirect
	golang.org/x/text v0.37.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260526163538-3dc84a4a5aaa // indirect
	google.golang.org/protobuf v1.36.12 // indirect
)
