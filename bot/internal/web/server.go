package web

type Server struct {
    // Пока заглушка
}

func NewServer(cfg interface{}, manager interface{}, repo interface{}, logger interface{}) *Server {
    return &Server{}
}

func (s *Server) Start(ctx interface{}) error {
    return nil
}

func (s *Server) Stop(ctx interface{}) error {
    return nil
}
